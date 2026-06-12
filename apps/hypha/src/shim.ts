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
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ForwardControlClient } from "./forward-control.ts";
import { parseMultipart, boundaryOf } from "./multipart-parse.ts";
import { forwardBillingTokens, forwardCeilingTokens, type ForwardUsage } from "./forward-metering.ts";
import { openForwardSession, closeForwardSession, type ForwardSettlementDeps } from "./forward-settlement.ts";
import { descriptorFor } from "./catalog.ts";
import { flattenContent, parseDataUrlImage, type ContentPart } from "./chat-attachments.ts";
import { HYPHA_TTFB_MS, HYPHA_ECONOMY_TEST_HOOKS, HYPHA_FORWARD_METERED } from "./config.ts";
import { meshBus, MESH_EVENT } from "./mesh-events.ts";

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
  /** Delete a mesh THIS device founded (creator-gated; the primary mesh is never deletable). */
  deleteMesh(meshId: string): Promise<{ ok: boolean; error?: string }>;
  /** Leave a mesh THIS device joined — drops only our own membership (any member; primary is never leavable). */
  leaveMesh(meshId: string): Promise<{ ok: boolean; error?: string }>;
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
  /** True only on meshes THIS device founded — gates the Delete-mesh action in the UI. */
  creator: boolean;
}

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

/**
 * Flatten a chat message to text + materialize any inline `data:` images to temp files (tracked for
 * cleanup) — this is how VISION (qwen3vl) borrows over the chat path: OpenAI sends images as
 * `image_url` content parts, the delegated `completion()` wants `attachments:[{path}]`. The SDK reads
 * the file on THIS (consumer) side and sends the bytes to the provider. Parsing/decoding is the pure
 * `chat-attachments` module; this only adds the temp-file write.
 */
function extractParts(content: ChatMessage["content"], tmp: string[]): { text: string; attachments: { path: string }[] } {
  const { text, images } = flattenContent(content);
  const attachments: { path: string }[] = [];
  for (const url of images) {
    const decoded = parseDataUrlImage(url);
    if (!decoded) continue;
    const file = join(tmpdir(), `hypha-img-${randomUUID()}.${decoded.ext}`);
    try {
      writeFileSync(file, decoded.bytes);
      tmp.push(file);
      attachments.push({ path: file });
    } catch {
      /* best-effort: a temp-write failure just drops the image */
    }
  }
  return { text, attachments };
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

/** Does any message carry an inline image part? Such requests can't ride SDK delegation (attachments
 *  are path-only, read on the worker), so they go over the forward transport to the peer's local serve. */
function requestHasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => flattenContent(m.content).images.length > 0);
}

/** Stream a chat request to the first capable peer in `peers` over the forward transport (the peer runs
 *  it on its LOCAL serve — inline image bytes → vision — and streams tokens back). Fails over to the next
 *  peer if one errors BEFORE any byte reaches the client; once streaming has started it can't retry. */
async function streamForwardChat(
  res: http.ServerResponse,
  forward: ForwardControlClient,
  peers: string[],
  args: { id: string; alias: string; created: number; stream: boolean; body: unknown },
  inflight: Inflight,
  audit?: AuditLog,
): Promise<ForwardUsage | undefined> {
  inflight.inc();
  let clientOpen = true;
  res.on("close", () => { clientOpen = false; });
  let committed = false; // true once we've written the response head to the client → no more failover
  let lastErr: Error | null = null;
  const writeHead = (): void => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(sseChunk(args.id, args.alias, args.created, { role: "assistant" }, null));
    committed = true;
  };
  try {
    for (const peerKey of peers) {
      const t0 = Date.now();
      let tokens = 0;
      let full = "";
      try {
        const gen = forward.forward(peerKey, { id: args.id, endpoint: "/v1/chat/completions", body: args.body });
        let next = await gen.next();
        while (next.done !== true) {
          tokens++;
          full += next.value;
          if (args.stream) {
            if (!committed && clientOpen) writeHead();
            if (clientOpen) res.write(sseChunk(args.id, args.alias, args.created, { content: next.value }, null));
          }
          next = await gen.next();
        }
        const usage = (next.value as { usage?: ForwardUsage } | undefined)?.usage;
        audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-done", peer: peerKey.slice(0, 16), alias: args.alias, tokens, ms: Date.now() - t0 } });
        meshBus.record({ kind: "done", phase: "forward-done", peer: peerKey.slice(0, 16), alias: args.alias, tokens, ms: Date.now() - t0 });
        if (!clientOpen) return usage;
        if (args.stream) {
          if (!committed) writeHead();
          res.write(sseChunk(args.id, args.alias, args.created, {}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          committed = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: args.id, object: "chat.completion", created: args.created, model: args.alias, choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }] }));
        }
        return usage;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-failed", peer: peerKey.slice(0, 16), alias: args.alias, committed, error: lastErr.message } });
        meshBus.record({ kind: "failed", phase: "forward-failed", peer: peerKey.slice(0, 16), alias: args.alias, error: lastErr.message });
        if (committed) {
          if (clientOpen) { try { res.write(`data: ${JSON.stringify({ error: { message: `hypha forward: ${lastErr.message}` } })}\n\n`); res.end(); } catch { /* client gone */ } }
          return;
        }
        // nothing written yet → fail over to the next capable peer
      }
    }
    if (!clientOpen) return;
    const message = lastErr?.message ?? "no capable peer";
    try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `hypha forward: ${message}`, code: "forward_failed" } })); } catch { /* client gone */ }
  } finally {
    inflight.dec();
  }
}

/** Forward a non-chat request whose answer is a single JSON body (embeddings) and relay it back, trying
 *  each capable peer in turn — the response isn't written until fully collected, so failover is clean. */
async function forwardJsonResponse(
  res: http.ServerResponse,
  forward: ForwardControlClient,
  peers: string[],
  endpoint: string,
  body: unknown,
  inflight: Inflight,
  audit?: AuditLog,
): Promise<ForwardUsage | undefined> {
  inflight.inc();
  let lastErr: Error | null = null;
  try {
    for (const peerKey of peers) {
      const t0 = Date.now();
      try {
        const gen = forward.forward(peerKey, { id: `fwd-${randomUUID()}`, endpoint, body });
        let out = "";
        let next = await gen.next();
        while (next.done !== true) { out += next.value; next = await gen.next(); }
        const usage = (next.value as { usage?: ForwardUsage } | undefined)?.usage;
        audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-json-done", peer: peerKey.slice(0, 16), endpoint, ms: Date.now() - t0 } });
        meshBus.record({ kind: "done", phase: "forward-json-done", peer: peerKey.slice(0, 16), endpoint, ms: Date.now() - t0 });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(out);
        return usage;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-failed", peer: peerKey.slice(0, 16), endpoint, error: lastErr.message } });
        meshBus.record({ kind: "failed", phase: "forward-failed", peer: peerKey.slice(0, 16), endpoint, error: lastErr.message });
      }
    }
    const message = lastErr?.message ?? "no capable peer";
    try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `hypha forward: ${message}`, code: "forward_failed" } })); } catch { /* client gone */ }
  } finally {
    inflight.dec();
  }
}

/** Forward a request whose answer is binary (audio/speech): reassemble base64 chunk frames → bytes,
 *  trying each capable peer in turn (nothing written until fully collected → clean failover). */
async function forwardBinaryResponse(
  res: http.ServerResponse,
  forward: ForwardControlClient,
  peers: string[],
  endpoint: string,
  body: unknown,
  contentType: string,
  inflight: Inflight,
  audit?: AuditLog,
): Promise<ForwardUsage | undefined> {
  inflight.inc();
  let lastErr: Error | null = null;
  try {
    for (const peerKey of peers) {
      const t0 = Date.now();
      try {
        const gen = forward.forward(peerKey, { id: `fwd-${randomUUID()}`, endpoint, body });
        const parts: Buffer[] = [];
        let next = await gen.next();
        while (next.done !== true) { parts.push(Buffer.from(next.value, "base64")); next = await gen.next(); }
        const stats = next.value as { contentType?: string; usage?: ForwardUsage } | undefined;
        const audio = Buffer.concat(parts);
        // Use the serve's ACTUAL content-type (stamped in the provider's done frame), falling back to the
        // request-format guess — supertonic returns WAV regardless of `response_format`.
        const ct = typeof stats?.contentType === "string" && stats.contentType ? stats.contentType : contentType;
        audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-binary-done", peer: peerKey.slice(0, 16), endpoint, bytes: audio.length, contentType: ct, ms: Date.now() - t0 } });
        meshBus.record({ kind: "done", phase: "forward-binary-done", peer: peerKey.slice(0, 16), endpoint, bytes: audio.length, ms: Date.now() - t0 });
        res.writeHead(200, { "content-type": ct });
        res.end(audio);
        return stats?.usage;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-failed", peer: peerKey.slice(0, 16), endpoint, error: lastErr.message } });
        meshBus.record({ kind: "failed", phase: "forward-failed", peer: peerKey.slice(0, 16), endpoint, error: lastErr.message });
      }
    }
    const message = lastErr?.message ?? "no capable peer";
    try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `hypha forward: ${message}`, code: "forward_failed" } })); } catch { /* client gone */ }
  } finally {
    inflight.dec();
  }
}

/**
 * Run a forward modality, metering it when B4 is on and the chosen peer charges. `settleDeps` is null
 * (flag off / no local x402) → FREE path: run the helper across ALL peers (failover). Otherwise, if the
 * top peer advertises a paid rail → PAID path: open an x402 session, forward to that ONE peer only (no
 * failover under a session), and close with the actual billing-tokens. closeAttempted guards the close.
 */
async function forwardWithOptionalSettlement(
  res: http.ServerResponse,
  settleDeps: ForwardSettlementDeps | null,
  router: MeshRouter,
  alias: string,
  endpoint: string,
  ceilingBody: Record<string, unknown>,
  peers: string[],
  run: (peers: string[]) => Promise<ForwardUsage | undefined>,
): Promise<void> {
  const meta = settleDeps ? router.forwardSettlementMeta(alias, peers[0]!) : null;
  if (!settleDeps || !meta?.requiresSession) { await run(peers); return; }
  const opened = await openForwardSession(settleDeps, meta, peers[0]!, alias, forwardCeilingTokens(endpoint, ceilingBody));
  if (!opened.ok) {
    try { res.writeHead(opened.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `hypha forward: ${opened.error}`, code: "payment_required" } })); } catch { /* client gone */ }
    return;
  }
  let closeAttempted = false;
  try {
    const usage = await run([peers[0]!]);
    closeAttempted = true; // set BEFORE the close so a throw can't fire a second (zero-)close (race c112b243)
    await closeForwardSession(settleDeps, opened.session, usage ? forwardBillingTokens(usage) : 0);
  } catch (err) {
    if (!closeAttempted) { closeAttempted = true; await closeForwardSession(settleDeps, opened.session, 0).catch(() => undefined); }
    // run() writes its own error response; never re-throw out of a request handler (it would crash the daemon).
    settleDeps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-session-error", peer: peers[0]!.slice(0, 16), error: err instanceof Error ? err.message : String(err) } });
  }
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
  /** Forward transport for non-delegable modalities (vision today; embed/stt/tts in B2), or null when
   *  HYPHA_FORWARD is off → vision falls through to the (image-broken cross-machine) delegation path. */
  forward?: ForwardControlClient | null;
  /** Record a local reputation observation of a delegated completion (provider key, delivered?, TTFB). */
  recordObservation?: (providerId: string, ok: boolean, ttftMs?: number) => void;
  /** Snapshot for `GET /reputation` (per-provider scores), or undefined if reputation isn't wired. */
  getReputation?: () => unknown;
  /** Mesh model sharing toggle (advisory): whether peers may discover + pull this node's models. */
  getShareModels?: () => boolean;
  setShareModels?: (on: boolean) => void | Promise<void>;
  /** Per-alias sharing: the deny-set of aliases NOT advertised to the mesh, and a per-alias toggle. */
  getUnsharedModels?: () => string[];
  setAliasShared?: (alias: string, on: boolean) => void | Promise<void>;
}

export function createShim(deps: ShimDeps): http.Server {
  const { getRouter, getSelfConsumerKey, inflight, pairing, mesh, audit, kv, settlement, paymentControl, forward, recordObservation, getReputation, getShareModels, setShareModels, getUnsharedModels, setAliasShared } = deps;
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
      // `self`: THIS device's own provider/consumer key + payout wallet, so a consumer dashboard can
      // split its own earnings (receipts paid TO this wallet) from its spend (receipts paid BY it).
      // Additive — none of the per-peer rows describe self. wallet is null when no payout rail is online.
      const self = { providerKey: getSelfConsumerKey(), wallet: settlement?.payoutEndpoints()[0]?.recipient ?? null };
      return json(res, 200, { peers: router ? router.peers() : [], self, ...info });
    }
    // ── live routing event stream (SSE) — the browser-subscribable mirror of the JSONL
    //    delegation audit; powers the living-mesh visualization. localhost control surface. ──
    if (method === "GET" && (url === "/events" || url.startsWith("/events?"))) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // Replay recent routing activity so a freshly-connected viz shows context at once.
      for (const e of meshBus.recent()) { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* client gone */ } }
      try { res.write("event: ready\ndata: {}\n\n"); } catch { /* client gone */ }
      const onEvt = (e: unknown): void => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* client gone */ } };
      meshBus.on(MESH_EVENT, onEvt);
      const ping = setInterval(() => { try { res.write(":keepalive\n\n"); } catch { /* client gone */ } }, 15000);
      ping.unref?.();
      res.on("close", () => { clearInterval(ping); meshBus.off(MESH_EVENT, onEvt); });
      return;
    }
    if (method === "GET" && url === "/receipts") {
      return json(res, 200, { receipts: await mesh.receipts() });
    }
    if (method === "GET" && url === "/reputation") {
      return json(res, 200, { reputation: getReputation ? getReputation() : [] });
    }
    // Mesh model sharing toggle (advisory) — peers may discover + pull this node's models when on.
    if (method === "GET" && url === "/models/share") {
      return json(res, 200, { shareModels: getShareModels ? getShareModels() : true, unshared: getUnsharedModels ? getUnsharedModels() : [] });
    }
    if (method === "POST" && url === "/models/share") {
      const body = await readJsonBody(req);
      // Per-alias toggle when an `alias` is given; otherwise the node-wide share switch.
      if (typeof body["alias"] === "string") {
        const alias = body["alias"] as string;
        const on = Boolean(body["on"]);
        await setAliasShared?.(alias, on);
        return json(res, 200, { ok: true, alias, on });
      }
      const on = Boolean(body["on"]);
      await setShareModels?.(on);
      return json(res, 200, { ok: true, shareModels: on });
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
      if (method === "POST" && url === "/mesh/delete") {
        const r = await mesh.deleteMesh(String((await readJsonBody(req))["meshId"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      if (method === "POST" && url === "/mesh/leave") {
        const r = await mesh.leaveMesh(String((await readJsonBody(req))["meshId"] ?? ""));
        return json(res, r.ok ? 200 : 400, r);
      }
      return json(res, 404, { error: `hypha: no mesh route ${method} ${url}` });
    }

    // B4: the settlement context for a metered forward request. null = free path (flag off, or no local
    // x402) → forwardWithOptionalSettlement just runs with failover. Re-read getSelfConsumerKey per request.
    const forwardSettleDeps = (): ForwardSettlementDeps | null => {
      const sk = getSelfConsumerKey();
      return HYPHA_FORWARD_METERED && settlement && sk ? { paymentControl, settlement, selfConsumerKey: sk, ...(audit ? { audit } : {}) } : null;
    };

    // ── SP2 Option B — borrow non-chat modalities over the forward transport ──────────────────────
    // The provider runs them on its LOCAL serve (embeddings vector, TTS audio). STT (multipart upload)
    // is a follow-on. OFF (HYPHA_FORWARD) → these 404 like before.
    if (forward && method === "POST" && (url.startsWith("/v1/embeddings") || url.startsWith("/v1/audio/speech"))) {
      const fwdRouter = getRouter();
      if (!fwdRouter || !fwdRouter.online()) return json(res, 503, { error: { message: "hypha: mesh offline (device not paired)", code: "mesh_offline" } });
      let fbody: { model?: string; sensitivity?: string; meshId?: string; response_format?: string };
      try {
        fbody = JSON.parse((await readBody(req)).toString("utf-8"));
      } catch (err) {
        return json(res, 400, { error: { message: `hypha shim: bad JSON: ${String(err)}` } });
      }
      const fwdAlias = fbody.model;
      if (!fwdAlias) return json(res, 400, { error: { message: "hypha shim: `model` (alias) is required" } });
      const fwdSensitivity = fbody.sensitivity === "shareable" ? "shareable" : "private";
      const fwdPeers = fwdRouter.forwardTargetsForAlias({ alias: fwdAlias, sensitivity: fwdSensitivity, ...(fbody.meshId ? { pinMeshId: fbody.meshId } : {}) });
      if (fwdPeers.length === 0) return json(res, 503, { error: { message: `hypha shim: no peer serves "${fwdAlias}" for forwarding`, code: "no_forward_peer" } });
      audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-route", peers: fwdPeers.length, peer: fwdPeers[0]!.slice(0, 16), alias: fwdAlias, endpoint: url.split("?")[0] } });
      meshBus.record({ kind: "route", phase: "forward-route", peers: fwdPeers.length, peer: fwdPeers[0]!.slice(0, 16), alias: fwdAlias, endpoint: url.split("?")[0] });
      if (url.startsWith("/v1/audio/speech")) {
        const ct = fbody.response_format === "wav" ? "audio/wav" : "audio/mpeg";
        return forwardWithOptionalSettlement(res, forwardSettleDeps(), fwdRouter, fwdAlias, "/v1/audio/speech", fbody as Record<string, unknown>, fwdPeers,
          (peers) => forwardBinaryResponse(res, forward, peers, "/v1/audio/speech", fbody, ct, inflight, audit));
      }
      return forwardWithOptionalSettlement(res, forwardSettleDeps(), fwdRouter, fwdAlias, "/v1/embeddings", fbody as Record<string, unknown>, fwdPeers,
        (peers) => forwardJsonResponse(res, forward, peers, "/v1/embeddings", fbody, inflight, audit));
    }

    // STT — /v1/audio/transcriptions uploads a file (multipart/form-data). Parse out the audio + model,
    // forward the audio inline as base64, and the provider rebuilds the multipart for its local serve.
    if (forward && method === "POST" && url.startsWith("/v1/audio/transcriptions")) {
      const sttRouter = getRouter();
      if (!sttRouter || !sttRouter.online()) return json(res, 503, { error: { message: "hypha: mesh offline (device not paired)", code: "mesh_offline" } });
      const boundary = boundaryOf(String(req.headers["content-type"] ?? ""));
      if (!boundary) return json(res, 400, { error: { message: "hypha shim: /v1/audio/transcriptions expects multipart/form-data" } });
      const sttParts = parseMultipart(await readBody(req), boundary);
      const filePart = sttParts.find((p) => p.name === "file");
      const sttModel = sttParts.find((p) => p.name === "model")?.data.toString("utf8").trim();
      if (!filePart || !sttModel) return json(res, 400, { error: { message: "hypha shim: `model` and `file` are required" } });
      const sttPeers = sttRouter.forwardTargetsForAlias({ alias: sttModel, sensitivity: "private" });
      if (sttPeers.length === 0) return json(res, 503, { error: { message: `hypha shim: no peer serves "${sttModel}" for forwarding`, code: "no_forward_peer" } });
      const sttBody: Record<string, unknown> = { model: sttModel, audio_base64: filePart.data.toString("base64"), filename: filePart.filename ?? "audio.wav" };
      for (const k of ["response_format", "language", "prompt"]) {
        const v = sttParts.find((p) => p.name === k)?.data.toString("utf8");
        if (v !== undefined) sttBody[k] = v;
      }
      audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-route", peers: sttPeers.length, peer: sttPeers[0]!.slice(0, 16), alias: sttModel, endpoint: "/v1/audio/transcriptions" } });
      meshBus.record({ kind: "route", phase: "forward-route", peers: sttPeers.length, peer: sttPeers[0]!.slice(0, 16), alias: sttModel, endpoint: "/v1/audio/transcriptions" });
      return forwardWithOptionalSettlement(res, forwardSettleDeps(), sttRouter, sttModel, "/v1/audio/transcriptions", sttBody, sttPeers,
        (peers) => forwardJsonResponse(res, forward, peers, "/v1/audio/transcriptions", sttBody, inflight, audit));
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
      stallMs?: number; // test-only (HYPHA_ECONOMY_TEST_HOOKS): go silent mid-metered-session
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

    // SP2 Option B — vision (and later embed/stt/tts) can't ride SDK delegation (attachments are
    // path-only, read on the worker) and is advertised borrowable:false. The forward transport borrows
    // it from a peer's LOCAL serve instead: when the request carries images and forward is on, pick a
    // peer that SERVES the alias (no delegated warm needed) and send the OpenAI body (image bytes
    // inline) over the forward channel; the peer runs it on its serve and streams the answer back.
    if (forward && requestHasImages(body.messages)) {
      const peers = router.forwardTargetsForAlias({ alias, sensitivity, ...(body.meshId ? { pinMeshId: body.meshId } : {}) });
      if (peers.length === 0) return json(res, 503, { error: { message: `hypha shim: no peer serves "${alias}" for image forwarding`, code: "no_forward_peer" } });
      audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-route", peers: peers.length, peer: peers[0]!.slice(0, 16), alias } });
      meshBus.record({ kind: "route", phase: "forward-route", peers: peers.length, peer: peers[0]!.slice(0, 16), alias });
      const chatArgs = {
        id: `chatcmpl-${randomUUID()}`,
        alias,
        created: Math.floor(Date.now() / 1000),
        stream: body.stream !== false,
        body: { model: alias, messages: body.messages },
      };
      return forwardWithOptionalSettlement(res, forwardSettleDeps(), router, alias, "/v1/chat/completions", body as Record<string, unknown>, peers,
        (ps) => streamForwardChat(res, forward, ps, chatArgs, inflight, audit));
    }

    const warm = router.route({ alias, sensitivity, ...(body.meshId ? { pinMeshId: body.meshId } : {}) });
    if (!warm) return json(res, 503, { error: { message: `hypha shim: no eligible warm peer serves "${alias}"`, code: "no_warm_peer" } });
    meshBus.record({ kind: "route", phase: "route", peer: warm.peerKey.slice(0, 16), alias, meshId: warm.meshId });

    // Build history, materializing any inline images as attachments (vision borrowing). Temp images
    // are cleaned up when the response closes (after the decode has drained — the SDK already read them).
    const tmpImages: string[] = [];
    res.on("close", () => {
      for (const f of tmpImages) {
        try {
          unlinkSync(f);
        } catch {
          /* best-effort temp cleanup */
        }
      }
    });
    const history = body.messages.map((m) => {
      const { text, attachments } = extractParts(m.content, tmpImages);
      return attachments.length ? { role: m.role, content: text, attachments } : { role: m.role, content: text };
    });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream !== false;
    const requestedBudget = body.computeBudget == null ? undefined : Number(body.computeBudget);
    if (requestedBudget != null && (!Number.isFinite(requestedBudget) || requestedBudget <= 0)) {
      return json(res, 400, { error: { message: "hypha shim: `computeBudget` must be a positive number" } });
    }
    // Test-only: simulate an abandoned/stalled metered consumer (go silent after the first advance so
    // the provider's idle watchdog force-settles the authorized cap). Ignored unless TEST_HOOKS is on.
    const testStallMs = HYPHA_ECONOMY_TEST_HOOKS && typeof body.stallMs === "number" && body.stallMs > 0 ? body.stallMs : 0;

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
        // Metered (provider offered it via quote.meteredChunkTokens): the open signs the TIER-0 chunk
        // cap, not the full ceiling, and each rung is signature-only — so the reservation must NOT also
        // create a payload (that extra payload broke the facilitator simulation, found live 2026-06-10).
        // Reserve-only bounds the float; signTier() produces the only on-chain witnesses. Non-metered =
        // the proven path (authorize reserves AND signs the full maxAmount at open).
        const meteredSession = quote.meteredChunkTokens != null;
        budgetAuth = meteredSession
          ? await settlement.reserveBudgetOnly(warm.peerKey, quote.maxAmount)
          : await settlement.authorizeBudget(warm.peerKey, quote.maxAmount);
        if (!budgetAuth.ok || budgetAuth.authorization.network !== "plasma") {
          return json(res, 402, {
            error: {
              message: `hypha shim: compute budget authorization failed: ${budgetAuth.ok ? "no Plasma x402 authorization path is available" : budgetAuth.reason}`,
              code: "payment_required",
            },
          });
        }
        const payerAddress = budgetAuth.authorization.authorization.payer;
        let openPayload = budgetAuth.authorization.authorization.paymentPayload;
        let openAccepted = budgetAuth.authorization.authorization.accepted;
        let openNonce = id;
        if (meteredSession) {
          const chunkAmount = quote.meteredChunkAmount ?? (settlement.plasmaService()?.amountForTokens(quote.meteredChunkTokens!) ?? 0);
          const tier0 = await settlement.signTier(warm.peerKey, chunkAmount);
          if (!tier0.ok) {
            return json(res, 402, { error: { message: `hypha shim: metered tier-0 authorization failed: ${tier0.reason}`, code: "payment_required" } });
          }
          openPayload = tier0.paymentPayload;
          openAccepted = tier0.accepted;
          openNonce = `${id}:0`;
        }
        const verify = await paymentControl.verifyBudget(warm.peerKey, {
          quote,
          consumerWriterKey: warm.consumerWriterKey,
          consumerPublicKey: selfConsumerKey,
          providerWriterKey: quote.providerWriterKey,
          providerPublicKey: warm.peerKey,
          payerAddress,
          nonce: openNonce,
          paymentPayload: openPayload,
          accepted: openAccepted,
        });
        sessionGrant = await paymentControl.openPaidSession(warm.peerKey, {
          quote,
          verificationId: verify.verificationId,
          consumerWriterKey: warm.consumerWriterKey,
          consumerPublicKey: selfConsumerKey,
          providerWriterKey: quote.providerWriterKey,
          providerPublicKey: warm.peerKey,
          payerAddress,
          nonce: openNonce,
        });
        runModelId = await loadDelegated({
          // Resolve to the rich SDK descriptor (registry:// src for registry models) — the bare
          // gossiped registryPath isn't directly loadable on the provider (see descriptorFor).
          modelSrc: descriptorFor(sessionGrant.modelSrc) as never,
          providerPublicKey: warm.peerKey,
          timeout: 60_000,
          fallbackToLocal: false,
          tools: false,
          audit,
        });

        // ── Metered (pay-as-you-go) decode loop ──────────────────────────────────────────────────
        // ONE delegated completion, `predict`-capped at the budget ceiling. We consume the stream and
        // authorize the NEXT rung (a fresh Permit2 witness for a higher cumulative cap) just before
        // crossing each chunk boundary — `await`ing that advance inside `for await` back-pressures the
        // provider's decode, so it can't run far past what's been paid. Probe finding (2026-06-10):
        // the earlier per-chunk-completion + history-accumulation design produced 0 tokens after the
        // first chunk (a re-pushed partial assistant turn reads as "done" and the model stops). One
        // continuous decode sidesteps mid-turn-resume entirely. Money still moves ONCE (provider
        // settles the highest reached rung at close); abandonment settles only the authorized cap.
        if (meteredSession) {
          const chunkTokens = quote.meteredChunkTokens!;
          const plasma = settlement.plasmaService();
          if (!plasma) throw new Error("hypha shim: metered session requires the Plasma service");
          // Cap the single decode at the budget ceiling so it never generates past what the quote covers.
          const ceilingTokens = quote.pricePerKiloToken > 0
            ? Math.max(chunkTokens, Math.floor((quote.maxAmount * 1000) / quote.pricePerKiloToken))
            : chunkTokens;
          if (stream && clientOpen) {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            res.write(sseChunk(id, alias, created, { role: "assistant" }, null));
          }
          let text = "";
          let produced = 0;
          let tier = 0; // tier-0 (cumulative chunkTokens) is authorized by the open above
          let authStopped = false;
          let stalled = false; // test-only: go silent once after the first advance (abandon watchdog)
          const grant = sessionGrant; // non-null here; captured so the closure keeps the narrowing
          // Escalate the authorization ladder so tokens up to index `need` are covered. Returns false
          // when the next rung would exceed the quoted ceiling or can't be signed (→ stop pulling).
          const ensureAuthorizedFor = async (need: number): Promise<boolean> => {
            while (need >= (tier + 1) * chunkTokens) {
              const nextTier = tier + 1;
              const cumulativeTokens = (nextTier + 1) * chunkTokens;
              const cumulativeAmount = plasma.amountForTokens(cumulativeTokens);
              if (cumulativeAmount > quote.maxAmount) return false;
              const sig = await settlement.signTier(warm.peerKey, cumulativeAmount);
              if (!sig.ok) return false;
              await paymentControl.advanceAuthorization(warm.peerKey, {
                sessionId: grant.sessionId,
                consumerWriterKey: warm.consumerWriterKey,
                consumerPublicKey: grant.consumerPublicKey,
                providerWriterKey: grant.providerWriterKey,
                providerPublicKey: warm.peerKey,
                tierIndex: nextTier,
                cumulativeTokens,
                payerAddress,
                nonce: `${id}:${nextTier}`,
                paymentPayload: sig.paymentPayload,
                accepted: sig.accepted,
              });
              tier = nextTier;
              // Test-only: after the first advance, go silent so the provider's idle watchdog
              // force-settles the authorized cap (proves the abandoned-session backstop).
              if (testStallMs > 0 && !stalled) {
                stalled = true;
                await new Promise((r) => setTimeout(r, testStallMs));
              }
            }
            return true;
          };
          const onToken = (tok: unknown): void => {
            const s = typeof tok === "string" ? tok : String(tok);
            if (tokenCount === 0) ttft = Date.now() - t0;
            tokenCount++;
            produced++;
            text += s;
            if (stream && clientOpen) res.write(sseChunk(id, alias, created, { content: s }, null));
          };
          const run = completion({ modelId: runModelId, history, stream: true, generationParams: { predict: ceilingTokens } });
          const restIt = run.tokenStream[Symbol.asyncIterator]();
          // TTFB guard on the session's very first token (a dead delegated decode self-heals loud).
          let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
          const first = await Promise.race([
            restIt.next(),
            new Promise<"ttfb-timeout">((resolve) => { ttfbTimer = setTimeout(() => resolve("ttfb-timeout"), HYPHA_TTFB_MS); ttfbTimer.unref?.(); }),
          ]);
          clearTimeout(ttfbTimer);
          if (first === "ttfb-timeout") {
            void (async () => { for (let n = await restIt.next(); !n.done; n = await restIt.next()) { /* drain */ } })().catch(() => {});
            void run.final.catch(() => {});
            throw new Error(`hypha shim: no first token within ${HYPHA_TTFB_MS}ms from metered peer serving "${alias}"`);
          }
          for await (const tok of prependToken(first, restIt)) {
            // `produced` = tokens already consumed = the index of `tok`. Authorize before crossing the cap.
            if (!(await ensureAuthorizedFor(produced))) { authStopped = true; break; }
            onToken(tok);
            if (!clientOpen) break; // client gone — stop paying for more (we'll drain below; wedge rule)
          }
          if (authStopped || !clientOpen) {
            // Stop reading but NEVER abort the provider's decode — drain it in the background.
            void (async () => { for (let n = await restIt.next(); !n.done; n = await restIt.next()) { /* drain */ } })().catch(() => {});
          }
          await run.final.catch(() => undefined);
          if (clientOpen && stream) {
            res.write(sseChunk(id, alias, created, {}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (clientOpen && !stream) {
            json(res, 200, { id, object: "chat.completion", created, model: alias, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
          }
          closeAttempted = true;
          sessionReceipt = await paymentControl.closePaidSession(warm.peerKey, {
            sessionId: sessionGrant.sessionId,
            consumerWriterKey: warm.consumerWriterKey,
            consumerPublicKey: sessionGrant.consumerPublicKey,
            providerWriterKey: sessionGrant.providerWriterKey,
            providerPublicKey: warm.peerKey,
            actualTokens: produced,
          });
          if (sessionReceipt.status === "settled" && budgetAuth.ok && budgetAuth.authorization.network === "plasma") {
            await settlement.finalizeAuthorized(budgetAuth.authorization, sessionReceipt.actualAmount, sessionReceipt.txHash);
          }
          audit?.record({
            event: "completion",
            modelId: runModelId,
            ttftMs: ttft,
            tokens: produced,
            durationMs: Date.now() - t0,
            extra: {
              role: "shim",
              delegated: true,
              metered: true,
              tiers: tier + 1,
              alias,
              meshId: warm.meshId,
              peer: warm.peerKey.slice(0, 16),
              ...(requestedBudget != null ? { computeBudget: requestedBudget } : {}),
              sessionId: sessionReceipt.sessionId,
              sessionStatus: sessionReceipt.status,
              sessionAmount: sessionReceipt.actualAmount,
              sessionTxHash: sessionReceipt.txHash,
            },
          });
          recordObservation?.(warm.peerKey, produced > 0, ttft); // delivered tokens → positive signal
          meshBus.record({ kind: "done", phase: "completion", peer: warm.peerKey.slice(0, 16), alias, tokens: produced, ms: Date.now() - t0 });
          return;
        }
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
        recordObservation?.(warm.peerKey, false); // dead delegated decode → negative reputation signal
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
      recordObservation?.(warm.peerKey, tokenCount > 0, ttft); // delivered tokens → positive signal
      meshBus.record({ kind: "done", phase: "completion", peer: warm.peerKey.slice(0, 16), alias, tokens: tokenCount, ms: Date.now() - t0 });
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
      meshBus.record({ kind: "failed", phase: "completion-failed", peer: warm.peerKey.slice(0, 16), alias, error: msg });
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
