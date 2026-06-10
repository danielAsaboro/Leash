/**
 * The local control surface (:11437): the OpenAI overflow shim the broker sheds to, plus
 * the localhost pairing-control routes the dashboard drives. localhost-only by design.
 *
 *   POST /v1/chat/completions   — delegated completion → OpenAI SSE (mesh must be online,
 *                                 text-only, no tool-calling or embeddings support)
 *   GET  /peers                 — live mesh peers (warm-pool view)
 *   GET  /health                — liveness + mesh/pairing status
 *   POST /pair/mode {on}        · GET /pair/state · POST /pair/start {deviceKey}
 *   POST /pair/submit-pin {pin} · POST /pair/cancel
 *
 * Wedge discipline: a delegated decode is NEVER cancelled on client disconnect — drain it.
 * Mid-stream failures are surfaced (an SSE error frame), never silent-caught. The warm pool
 * is read through a getter because the mesh comes online lazily (only once paired).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AuditLog, SessionSettlementReceipt } from "@mycelium/shared";
import { completion, unloadModel } from "@qvac/sdk";
import type { CompletionFinal } from "@qvac/sdk";
import { loadDelegated } from "@mycelium/mesh";
import type { MeshRouter } from "./mesh-router.ts";
import type { DiscoveredDevice } from "./discovery.ts";
import type { KvSessions } from "@mycelium/shared";
import type { SettlementManager } from "./settlement-manager.ts";
import type { PaidSessionGrant } from "./economy-types.ts";
import type { PaymentControlClient } from "./payment-control.ts";
import { HYPHA_TTFB_MS } from "./config.ts";

export interface Inflight {
  inc(): void;
  dec(): void;
  get(): number;
}

/** Snapshot the dashboard polls while "Add a device" is open. */
export interface PairingState {
  mode: boolean;
  expiresInMs: number | null;
  meshOnline: boolean;
  selfName: string;
  discovered: DiscoveredDevice[];
  outgoing: { targetName: string; status: "await-pin" | "pairing" | "done"; error?: string } | null;
  incoming: { initiatorName: string; pin: string } | null;
  error: string | null;
}

/** Which mesh a host offers when it enters "Add a device" mode (default = the primary mesh). */
export interface PairTarget {
  /** Add the device to this existing mesh. */
  meshId?: string;
  /** …or found a NEW private mesh with this label and offer that. */
  newMeshLabel?: string;
}

/** What the shim's /pair/* routes delegate to (implemented by PairingController). */
export interface PairingControl {
  setMode(on: boolean, target?: PairTarget): Promise<{ ok: boolean; error?: string }>;
  state(): Promise<PairingState>;
  start(targetDeviceKey: string): Promise<{ ok: boolean; error?: string }>;
  submitPin(pin: string): Promise<{ ok: boolean; error?: string }>;
  cancel(): Promise<void>;
}

/** Mesh membership management — disconnecting peers + clearing stale ones (implemented in main). */
export interface MeshControl {
  /** Disconnect one peer: revoke its writer, forget its capability, drop it from the firewall + warm pool. */
  forgetPeer(deviceKey: string): Promise<{ ok: boolean; error?: string }>;
  /** Forget every peer whose heartbeat is stale (clears dead/stale connections). Returns how many. */
  forgetStale(): Promise<{ ok: boolean; count: number; error?: string }>;
  /** Clear a peer's local tombstone (un-hide it here) + best-effort retract the unpair mesh-wide. */
  restorePeer(deviceKey: string): Promise<{ ok: boolean; error?: string }>;
  /** Membership snapshot: writability, primary mesh id, local tombstones, + every membership. */
  meshInfo(): { writable: boolean | null; meshId: string | null; forgotten: string[]; meshes: MeshSummary[] };
  /** List this device's memberships (id, label, type, peer count, writability). */
  listMeshes(): Promise<MeshSummary[]>;
  /** Found a NEW private mesh of your own devices. Returns its local meshId. */
  newMesh(label: string): Promise<{ ok: boolean; meshId?: string; error?: string }>;
  /** Mint a blind invite for a mesh you belong to (to add a device to it). */
  inviteToMesh(meshId: string): Promise<{ ok: boolean; invite?: string; error?: string }>;
  /** Join an existing mesh as a NEW membership via a blind invite. Returns the new local meshId. */
  joinMesh(invite: string, label: string): Promise<{ ok: boolean; meshId?: string; error?: string }>;
  /** Join a public, discoverable cell (no pairing) by its id — broadcast-only gossip (spec §9). */
  joinPublicCell(cellId: string, label: string): Promise<{ ok: boolean; meshId?: string; error?: string }>;
  /** Replicated paid-session settlement receipts visible across this device's meshes. */
  receipts(): Promise<SessionSettlementReceipt[]>;
}

/** One membership row for the dashboard / `/mesh/list`. */
export interface MeshSummary {
  meshId: string;
  label: string;
  visibility: string;
  tier: number;
  peers: number;
  writable: boolean;
}

interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

function asText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Re-attach an already-raced first result to the rest of its iterator (TTFB guard plumbing). */
async function* prependToken<T>(first: IteratorResult<T>, rest: AsyncIterator<T>): AsyncGenerator<T> {
  if (!first.done) yield first.value;
  else return;
  while (true) {
    const n = await rest.next();
    if (n.done) return;
    yield n.value;
  }
}

function sseChunk(id: string, model: string, created: number, delta: object, finish: string | null): string {
  const payload = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface ShimDeps {
  /** Delegation router across this device's meshes, or null (no mesh online yet). */
  getRouter: () => MeshRouter | null;
  /** This device's delegated-compute consumer/provider key (same QVAC key on Hypha). */
  getSelfConsumerKey: () => string | null;
  inflight: Inflight;
  port: number;
  pairing: PairingControl;
  mesh: MeshControl;
  audit?: AuditLog;
  /** KV-cache session ledger (absent when HYPHA_KV_CACHE=0 — completions run uncached). */
  kv?: KvSessions;
  /** Optional bounded settlement service for delegated compute. */
  settlement?: SettlementManager;
  /** Persistent payment-control client (one per daemon; warmed in the background, closed on shutdown). */
  paymentControl: PaymentControlClient;
}

export function createShim(deps: ShimDeps): http.Server {
  const { getRouter, getSelfConsumerKey, inflight, pairing, mesh, audit, kv, settlement, paymentControl } = deps;
  const json = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
   try {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // ── status ──────────────────────────────────────────────────────────────────
    if (method === "GET" && url === "/health") {
      const router = getRouter();
      const info = mesh.meshInfo();
      return json(res, 200, { ok: true, port: deps.port, meshOnline: router?.online() ?? false, inflight: inflight.get(), warmAliases: router ? router.warmAliases() : [], peers: router ? router.peers().length : 0, ...info });
    }
    if (method === "GET" && url === "/peers") {
      const router = getRouter();
      const info = mesh.meshInfo();
      return json(res, 200, { peers: router ? router.peers() : [], ...info });
    }
    if (method === "GET" && url === "/receipts") {
      return json(res, 200, { receipts: await mesh.receipts() });
    }

    // ── pairing control (localhost only — this device's own dashboard) ───────────
    if (url.startsWith("/pair/")) {
      if (method === "GET" && url === "/pair/state") return json(res, 200, await pairing.state());
      if (method === "POST" && url === "/pair/mode") {
        const b = await readJsonBody(req);
        const r = await pairing.setMode(Boolean(b["on"]), (b["target"] as PairTarget) ?? undefined);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/pair/start") {
        const r = await pairing.start(String((await readJsonBody(req))["deviceKey"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/pair/submit-pin") {
        const r = await pairing.submitPin(String((await readJsonBody(req))["pin"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/pair/cancel") {
        await pairing.cancel();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: `hypha: no pairing route ${method} ${url}` });
    }

    // ── mesh membership: disconnect peers, clear stale, + manage memberships (localhost only) ──
    if (url.startsWith("/mesh/")) {
      if (method === "GET" && url === "/mesh/list") {
        return json(res, 200, { meshes: await mesh.listMeshes() });
      }
      if (method === "POST" && url === "/mesh/forget") {
        const r = await mesh.forgetPeer(String((await readJsonBody(req))["deviceKey"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/mesh/forget-stale") {
        return json(res, 200, await mesh.forgetStale());
      }
      if (method === "POST" && url === "/mesh/restore") {
        const r = await mesh.restorePeer(String((await readJsonBody(req))["deviceKey"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/mesh/new") {
        const r = await mesh.newMesh(String((await readJsonBody(req))["label"] ?? "Mesh"));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/mesh/invite") {
        const r = await mesh.inviteToMesh(String((await readJsonBody(req))["meshId"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/mesh/join") {
        const b = await readJsonBody(req);
        const r = await mesh.joinMesh(String(b["invite"] ?? ""), String(b["label"] ?? "Mesh"));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/mesh/public/join") {
        const b = await readJsonBody(req);
        const r = await mesh.joinPublicCell(String(b["cellId"] ?? ""), String(b["label"] ?? "Public cell"));
        return json(res, r.ok ? 200 : 400, r);
      }
      return json(res, 404, { error: `hypha: no mesh route ${method} ${url}` });
    }

    // ── overflow chat completions ────────────────────────────────────────────────
    if (!(method === "POST" && url.startsWith("/v1/chat/completions"))) {
      return json(res, 404, { error: `hypha shim: no route ${method} ${url}` });
    }

    const router = getRouter();
    if (!router || !router.online()) return json(res, 503, { error: { message: "hypha: mesh offline (device not paired)", code: "mesh_offline" } });

    let body: {
      model?: string;
      messages?: ChatMessage[];
      stream?: boolean;
      sensitivity?: string;
      meshId?: string;
      computeBudget?: number;
      tools?: unknown;
      tool_choice?: unknown;
      parallel_tool_calls?: unknown;
    };
    try {
      body = JSON.parse((await readBody(req)).toString("utf-8"));
    } catch (err) {
      return json(res, 400, { error: { message: `hypha shim: bad JSON: ${String(err)}` } });
    }
    const alias = body.model;
    if (!alias || !Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: "hypha shim: `model` (alias) and `messages` are required" } });
    }
    if (body.tools !== undefined || body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) {
      return json(res, 400, {
        error: {
          message:
            "hypha shim: tool-calling is not supported on /v1/chat/completions. Point Leash at the local qvac serve or broker for tool/skill/MCP turns; Hypha is delegated plain-chat only.",
          code: "tools_unsupported",
        },
      });
    }
    // Delegation ladder (spec §6): walk meshes by tier, capped by eligibility. `sensitivity`
    // defaults to private (fail-closed); an optional `meshId` hard-pins to one mesh.
    const sensitivity = body.sensitivity === "shareable" ? "shareable" : "private";
    const warm = router.route({ alias, sensitivity, ...(body.meshId ? { pinMeshId: body.meshId } : {}) });
    if (!warm) return json(res, 503, { error: { message: `hypha shim: no eligible warm peer serves "${alias}"`, code: "no_warm_peer" } });

    const history = body.messages.map((m) => ({ role: m.role, content: asText(m.content) }));
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream !== false;
    const requestedBudget = body.computeBudget == null ? undefined : Number(body.computeBudget);
    if (requestedBudget != null && (!Number.isFinite(requestedBudget) || requestedBudget <= 0)) {
      return json(res, 400, { error: { message: "hypha shim: `computeBudget` must be a positive number" } });
    }

    let clientOpen = true;
    res.on("close", () => {
      clientOpen = false;
    });

    inflight.inc();
    const t0 = Date.now();
    let ttft = 0;
    let tokenCount = 0;
    let runModelId = warm.modelId;
    let sessionGrant: PaidSessionGrant | null = null;
    let sessionReceipt: SessionSettlementReceipt | null = null;
    let budgetAuth: Awaited<ReturnType<SettlementManager["authorizeBudget"]>> | null = null;
    // Set the moment a close_paid_session is SENT. If that close itself fails (e.g. the provider's
    // settle outlives our round-trip budget), the catch below must NOT send a recovery zero-close:
    // the provider may still be settling the real token count, and a second close would zero-settle
    // the session out from under it (double-close race, found live 2026-06-10 session c112b243).
    let closeAttempted = false;
    try {
      if (warm.requiresSession) {
        if (!settlement?.plasmaService()) {
          return json(res, 402, { error: { message: "hypha shim: peer requires a paid Plasma session but local x402 is unavailable", code: "payment_required" } });
        }
        const selfConsumerKey = getSelfConsumerKey();
        if (!selfConsumerKey) {
          return json(res, 503, { error: { message: "hypha shim: consumer key unavailable", code: "mesh_offline" } });
        }
        const quote = await paymentControl.quoteBudget(warm.peerKey, {
          meshId: warm.meshId,
          alias,
          ...(warm.modelSrc ? { modelSrc: warm.modelSrc } : {}),
          ...(requestedBudget != null ? { requestedBudget } : {}),
          consumerWriterKey: warm.consumerWriterKey,
          consumerPublicKey: selfConsumerKey,
          providerPublicKey: warm.peerKey,
        });
        budgetAuth = await settlement.authorizeBudget(warm.peerKey, quote.maxAmount);
        if (!budgetAuth.ok || budgetAuth.authorization.network !== "plasma") {
          return json(res, 402, {
            error: {
              message: `hypha shim: compute budget authorization failed: ${budgetAuth.ok ? "no Plasma x402 authorization path is available" : budgetAuth.reason}`,
              code: "payment_required",
            },
          });
        }
        const verify = await paymentControl.verifyBudget(warm.peerKey, {
          quote,
          consumerWriterKey: warm.consumerWriterKey,
          consumerPublicKey: selfConsumerKey,
          providerWriterKey: quote.providerWriterKey,
          providerPublicKey: warm.peerKey,
          payerAddress: budgetAuth.authorization.authorization.payer,
          nonce: id,
          paymentPayload: budgetAuth.authorization.authorization.paymentPayload,
          accepted: budgetAuth.authorization.authorization.accepted,
        });
        sessionGrant = await paymentControl.openPaidSession(warm.peerKey, {
          quote,
          verificationId: verify.verificationId,
          consumerWriterKey: warm.consumerWriterKey,
          consumerPublicKey: selfConsumerKey,
          providerWriterKey: quote.providerWriterKey,
          providerPublicKey: warm.peerKey,
          payerAddress: budgetAuth.authorization.authorization.payer,
          nonce: id,
        });
        runModelId = await loadDelegated({
          modelSrc: sessionGrant.modelSrc as never,
          providerPublicKey: warm.peerKey,
          timeout: 60_000,
          fallbackToLocal: false,
          tools: false,
          audit,
        });
      } else {
        budgetAuth = settlement ? await settlement.authorizeBudget(warm.peerKey, requestedBudget) : null;
        if (budgetAuth && !budgetAuth.ok) {
          return json(res, 402, {
            error: {
              message: `hypha shim: compute budget authorization failed: ${budgetAuth.reason}`,
              code: "payment_required",
            },
          });
        }
      }
      if (!runModelId) throw new Error(`hypha shim: no delegated model is ready for "${alias}"`);
      // KV-cache session: reuse the provider-side cache only when the ledger PROVES this
      // request extends the exact committed prefix (kv-sessions.ts); else a fresh key.
      const kvRes = !sessionGrant && kv ? kv.resolve(alias, history, warm.peerKey) : null;
      const run = completion({ modelId: runModelId, history, stream: true, ...(kvRes ? { kvCache: kvRes.key } : {}) });
      if (stream && clientOpen) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(sseChunk(id, alias, created, { role: "assistant" }, null));
      }

      // TTFB guard: a peer that registered the delegated load but dies at decode (e.g. its
      // modelSrc path doesn't exist on ITS disk) yields no tokens and no error — a silent
      // forever-hang. Race the first token against HYPHA_TTFB_MS so it fails loud + self-heals.
      const rest = run.tokenStream[Symbol.asyncIterator]();
      let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        rest.next(),
        new Promise<"ttfb-timeout">((resolve) => {
          ttfbTimer = setTimeout(() => resolve("ttfb-timeout"), HYPHA_TTFB_MS);
          ttfbTimer.unref?.();
        }),
      ]);
      clearTimeout(ttfbTimer);
      if (first === "ttfb-timeout") {
        // Drop the warm entry (the 5s reconcile tick re-warms fresh) but do NOT cancel the
        // run — wedge discipline: abandon it draining in the background, exactly like a
        // client disconnect.
        if (!sessionGrant && warm.modelId) router.dropWarm(warm.modelId);
        void (async () => {
          for (let n = await rest.next(); !n.done; n = await rest.next()) {
            /* drain abandoned run */
          }
        })().catch(() => {});
        void run.final.catch(() => {}); // abandoned — never let it become an unhandled rejection
        const msg = `hypha shim: no first token within ${HYPHA_TTFB_MS}ms from peer serving "${alias}" (delegated decode dead) — warm entry dropped, re-warming`;
        audit?.record({ event: "note", extra: { role: "shim", phase: "ttfb-timeout", alias, peer: warm.peerKey.slice(0, 16), ttfbMs: HYPHA_TTFB_MS } });
        if (clientOpen) {
          if (!res.headersSent) json(res, 504, { error: { message: msg, code: "ttfb_timeout" } });
          else {
            res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
            res.end();
          }
        }
        if (sessionGrant) {
          closeAttempted = true;
          sessionReceipt = await paymentControl.closePaidSession(warm.peerKey, {
            sessionId: sessionGrant.sessionId,
            consumerWriterKey: warm.consumerWriterKey,
            consumerPublicKey: sessionGrant.consumerPublicKey,
            providerWriterKey: sessionGrant.providerWriterKey,
            providerPublicKey: warm.peerKey,
            actualTokens: 0,
          }).catch(() => null);
          if (sessionReceipt?.status === "settled" && budgetAuth?.ok && budgetAuth.authorization.network === "plasma") {
            await settlement?.finalizeAuthorized(budgetAuth.authorization, sessionReceipt.actualAmount, sessionReceipt.txHash);
          }
        } else if (budgetAuth?.ok) {
          settlement?.releaseAuthorized(budgetAuth.authorization);
        }
        return;
      }
      const tokenStream = prependToken(first, rest);

      // The full assistant text is accumulated in BOTH branches — the kv ledger commit
      // needs the exact reply that the provider's cache now holds.
      let text = "";
      if (stream) {
        for await (const token of tokenStream) {
          if (tokenCount === 0) ttft = Date.now() - t0;
          tokenCount++;
          text += token;
          if (clientOpen) res.write(sseChunk(id, alias, created, { content: token }, null));
        }
        if (clientOpen) {
          res.write(sseChunk(id, alias, created, {}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } else {
        for await (const token of tokenStream) {
          if (tokenCount === 0) ttft = Date.now() - t0;
          tokenCount++;
          text += token;
        }
        if (clientOpen) json(res, 200, { id, object: "chat.completion", created, model: alias, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
      }

      let finalOk = false;
      const stats = await run.final
        .then((f: CompletionFinal) => {
          finalOk = true;
          return f.stats;
        })
        .catch(() => undefined);
      // Commit ONLY on a clean final (drained disconnects included; the TTFB-timeout and
      // error paths never reach here) — an uncommitted entry stays dirty, so the next
      // turn of that session auto-bumps to a fresh key instead of trusting unknown state.
      if (kvRes && finalOk) kv?.commit(kvRes.sessionId, history, text);
      const settled = sessionGrant
        ? await (async () => {
          closeAttempted = true;
          sessionReceipt = await paymentControl.closePaidSession(warm.peerKey, {
            sessionId: sessionGrant.sessionId,
            consumerWriterKey: warm.consumerWriterKey,
            consumerPublicKey: sessionGrant.consumerPublicKey,
            providerWriterKey: sessionGrant.providerWriterKey,
            providerPublicKey: warm.peerKey,
            actualTokens: stats?.generatedTokens ?? tokenCount,
          });
          if (sessionReceipt.status === "settled" && budgetAuth?.ok && budgetAuth.authorization.network === "plasma") {
            return await settlement?.finalizeAuthorized(budgetAuth.authorization, sessionReceipt.actualAmount, sessionReceipt.txHash);
          }
          return null;
        })()
        : ((budgetAuth?.ok ? await settlement?.settleAuthorized(budgetAuth.authorization, stats?.generatedTokens ?? tokenCount) : null)
          ?? (settlement && (warm.settlements?.length || warm.settlement)
            ? await settlement.settle(warm.peerKey, stats?.generatedTokens ?? tokenCount)
            : null));
      if (settled && !settled.ok) {
        audit?.record({
          event: "note",
          extra: {
            role: "economy",
            phase: "settlement-failed",
            alias,
            meshId: warm.meshId,
            peer: warm.peerKey.slice(0, 16),
            reason: settled.reason,
            ...(requestedBudget != null ? { computeBudget: requestedBudget } : {}),
          },
        });
      }
      const receipt = sessionReceipt as SessionSettlementReceipt | null;
      if (receipt && receipt.status !== "settled") {
        audit?.record({
          event: "note",
          extra: {
            role: "economy",
            phase: "settlement-retrying",
            alias,
            meshId: warm.meshId,
            sessionId: receipt.sessionId,
            peer: warm.peerKey.slice(0, 16),
            amount: receipt.actualAmount,
            failureReason: receipt.failureReason,
          },
        });
      }
      audit?.record({
        event: "completion",
        modelId: runModelId,
        ttftMs: ttft,
        tokens: stats?.generatedTokens ?? tokenCount,
        tokensPerSecond: stats?.tokensPerSecond,
        ...(stats?.cacheTokens != null ? { cacheTokens: stats.cacheTokens } : {}),
        durationMs: Date.now() - t0,
        extra: {
          role: "shim",
          delegated: true,
          alias,
          meshId: warm.meshId,
          peer: warm.peerKey.slice(0, 16),
          ...(requestedBudget != null ? { computeBudget: requestedBudget } : {}),
          ...(settled?.ok
            ? {
                settlementNetwork: settled.network,
                settlementAsset: settled.asset,
                settlementAmount: settled.amount,
                settlementTxRef: settled.txRef,
                ...("mode" in settled ? { settlementMode: settled.mode } : {}),
              }
            : {}),
          ...(receipt
            ? {
                sessionId: receipt.sessionId,
                sessionStatus: receipt.status,
                sessionAmount: receipt.actualAmount,
                sessionTxHash: receipt.txHash,
              }
            : {}),
          ...(kvRes ? { kvKey: kvRes.key, kvFresh: kvRes.fresh } : {}),
        },
      });
    } catch (err) {
      if (sessionGrant && !closeAttempted) {
        closeAttempted = true;
        sessionReceipt = await paymentControl.closePaidSession(warm.peerKey, {
          sessionId: sessionGrant.sessionId,
          consumerWriterKey: warm.consumerWriterKey,
          consumerPublicKey: sessionGrant.consumerPublicKey,
          providerWriterKey: sessionGrant.providerWriterKey,
          providerPublicKey: warm.peerKey,
          actualTokens: 0,
        }).catch(() => null);
        if (sessionReceipt?.status === "settled" && budgetAuth?.ok && budgetAuth.authorization.network === "plasma") {
          await settlement?.finalizeAuthorized(budgetAuth.authorization, sessionReceipt.actualAmount, sessionReceipt.txHash).catch(() => undefined);
        }
      } else if (sessionGrant && closeAttempted) {
        // Our close already went out (and failed/timed out). The provider owns the session's fate
        // now — its settle either lands or enters retryUnsettled. Do NOT close again (zero-settle
        // race) and do NOT release the authorization (the provider's pending settle consumes it).
        audit?.record({ event: "note", extra: { role: "shim", phase: "close-recovery-skipped", alias, sessionId: sessionGrant.sessionId } });
      } else if (budgetAuth?.ok) {
        settlement?.releaseAuthorized(budgetAuth.authorization);
      }
      const msg = `hypha shim: delegated completion failed: ${err instanceof Error ? err.message : String(err)}`;
      audit?.record({ event: "note", extra: { role: "shim", alias, peer: warm.peerKey.slice(0, 16), error: msg, afterFirstByte: tokenCount > 0 } });
      if (clientOpen) {
        if (!res.headersSent) json(res, 502, { error: { message: msg, code: "delegation_failed" } });
        else {
          res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          res.end();
        }
      }
    } finally {
      if (sessionGrant && runModelId) await unloadModel({ modelId: runModelId }).catch(() => undefined);
      inflight.dec();
    }
   } catch (err) {
      // Last-resort guard: a route handler must NEVER crash the daemon (unhandled rejection).
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `hypha: ${err instanceof Error ? err.message : String(err)}` }));
        } else {
          res.end();
        }
      } catch {
        /* nothing more we can do */
      }
   }
  });
}
