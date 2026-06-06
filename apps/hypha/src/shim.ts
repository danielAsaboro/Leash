/**
 * The local control surface (:11437): the OpenAI overflow shim the broker sheds to, plus
 * the localhost pairing-control routes the dashboard drives. localhost-only by design.
 *
 *   POST /v1/chat/completions   — delegated completion → OpenAI SSE (mesh must be online)
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
import type { AuditLog } from "@mycelium/shared";
import { completion } from "@qvac/sdk";
import type { CompletionFinal } from "@qvac/sdk";
import type { WarmPool } from "./warm-pool.ts";
import type { DiscoveredDevice } from "./discovery.ts";
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

/** What the shim's /pair/* routes delegate to (implemented by PairingController). */
export interface PairingControl {
  setMode(on: boolean): Promise<{ ok: boolean; error?: string }>;
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
  /** Membership snapshot: writability, mesh id, local tombstones. Works even when the mesh is offline. */
  meshInfo(): { writable: boolean | null; meshId: string | null; forgotten: string[] };
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
  /** Warm pool when the mesh is online, else null (unpaired device). */
  getPool: () => WarmPool | null;
  inflight: Inflight;
  port: number;
  pairing: PairingControl;
  mesh: MeshControl;
  audit?: AuditLog;
}

export function createShim(deps: ShimDeps): http.Server {
  const { getPool, inflight, pairing, mesh, audit } = deps;
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
      const pool = getPool();
      const info = mesh.meshInfo();
      return json(res, 200, { ok: true, port: deps.port, meshOnline: pool !== null, inflight: inflight.get(), warmAliases: pool ? [...pool.warmAliases()] : [], peers: pool ? pool.peers().length : 0, ...info });
    }
    if (method === "GET" && url === "/peers") {
      const pool = getPool();
      const info = mesh.meshInfo();
      return json(res, 200, { peers: pool ? pool.peers() : [], ...info });
    }

    // ── pairing control (localhost only — this device's own dashboard) ───────────
    if (url.startsWith("/pair/")) {
      if (method === "GET" && url === "/pair/state") return json(res, 200, await pairing.state());
      if (method === "POST" && url === "/pair/mode") {
        const r = await pairing.setMode(Boolean((await readJsonBody(req))["on"]));
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

    // ── mesh membership: disconnect peers + clear stale (localhost only) ──────────
    if (url.startsWith("/mesh/")) {
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
      return json(res, 404, { error: `hypha: no mesh route ${method} ${url}` });
    }

    // ── overflow chat completions ────────────────────────────────────────────────
    if (!(method === "POST" && url.startsWith("/v1/chat/completions"))) {
      return json(res, 404, { error: `hypha shim: no route ${method} ${url}` });
    }

    const pool = getPool();
    if (!pool) return json(res, 503, { error: { message: "hypha: mesh offline (device not paired)", code: "mesh_offline" } });

    let body: { model?: string; messages?: ChatMessage[]; stream?: boolean };
    try {
      body = JSON.parse((await readBody(req)).toString("utf-8"));
    } catch (err) {
      return json(res, 400, { error: { message: `hypha shim: bad JSON: ${String(err)}` } });
    }
    const alias = body.model;
    if (!alias || !Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: "hypha shim: `model` (alias) and `messages` are required" } });
    }
    const warm = pool.modelIdForAlias(alias);
    if (!warm) return json(res, 503, { error: { message: `hypha shim: no warm peer serves "${alias}"`, code: "no_warm_peer" } });

    const history = body.messages.map((m) => ({ role: m.role, content: asText(m.content) }));
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream !== false;

    let clientOpen = true;
    res.on("close", () => {
      clientOpen = false;
    });

    inflight.inc();
    const t0 = Date.now();
    let ttft = 0;
    let tokenCount = 0;
    try {
      const run = completion({ modelId: warm.modelId, history, stream: true });
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
        pool.dropWarm(warm.modelId);
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
        return;
      }
      const tokenStream = prependToken(first, rest);

      if (stream) {
        for await (const token of tokenStream) {
          if (tokenCount === 0) ttft = Date.now() - t0;
          tokenCount++;
          if (clientOpen) res.write(sseChunk(id, alias, created, { content: token }, null));
        }
        if (clientOpen) {
          res.write(sseChunk(id, alias, created, {}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } else {
        let text = "";
        for await (const token of tokenStream) {
          if (tokenCount === 0) ttft = Date.now() - t0;
          tokenCount++;
          text += token;
        }
        if (clientOpen) json(res, 200, { id, object: "chat.completion", created, model: alias, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
      }

      const stats = await run.final.then((f: CompletionFinal) => f.stats).catch(() => undefined);
      audit?.record({ event: "completion", modelId: warm.modelId, ttftMs: ttft, tokens: stats?.generatedTokens ?? tokenCount, tokensPerSecond: stats?.tokensPerSecond, durationMs: Date.now() - t0, extra: { role: "shim", delegated: true, alias, peer: warm.peerKey.slice(0, 16) } });
    } catch (err) {
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
