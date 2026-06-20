/**
 * leash-broker — a cross-process priority queue in front of `qvac serve`.
 *
 *   npm run broker            (from repo root; or started from /services)
 *
 * The serve's llm-llamacpp addon serializes inference per model context (one decode per
 * model at a time). The SDK request-registry now QUEUES concurrent same-model requests
 * in-process (FIFO) instead of the old `Cannot set new job…` → 500, but every serve client
 * (web chat route, the compaction/dream/research children, the watcher) is a separate OS
 * process — so cross-process ordering still needs this proxy. The standalone chokepoint does:
 *
 *   · per-ALIAS serialization (concurrency 1 per model; different aliases run parallel)
 *   · cross-alias PRIORITY with AGING (interactive > inline > background; a starved
 *     background request's effective priority rises with wait time)
 *   · CANCEL-ON-DISCONNECT, centralized — on client disconnect it aborts the upstream
 *     fetch, so the serve's cancel-bridge cancels the decode and frees the slot (safe on
 *     current 0.13.x SDK line); the read loop drains only bytes already in flight, never the whole decode
 *   · NO upstream timeout — the broker is what lets long decodes survive
 *
 * Non-preemptive priority scheduling (the serve is a non-preemptible black box), modeled
 * on OS MLFQ/priority+aging; the LLM-serving papers (Orca, vLLM, FastServe, Sarathi)
 * explain the contention but assume engine control we don't have.
 *
 * Listens on :11436, forwards to the serve on :11435. Both overridable by env.
 */
import http from "node:http";
import { Agent, fetch as undiciFetch } from "undici";

const PORT = Number(process.env["LEASH_BROKER_PORT"] ?? 11436);
const UPSTREAM = (process.env["LEASH_BROKER_UPSTREAM"] ?? "http://127.0.0.1:11435").replace(/\/+$/, "");

/** Priority ranks (lower = served first). */
const RANK: Record<string, number> = { interactive: 0, inline: 1, background: 2 };
/** A waiting request gains one priority level for every AGING_MS it waits (anti-starvation). */
const AGING_MS = Number(process.env["LEASH_BROKER_AGING_MS"] ?? 8000);

// No upstream timeout — decodes are slow; the broker must not body-time-out the serve.
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 });

// ── Mesh overflow (Hypha) — purely additive; OFF unless LEASH_BROKER_HYPHA_URL is set.
// When on, a saturated/unavailable alias is shed to a paired peer's local OpenAI shim
// instead of waiting on the single local GPU. Unset → the broker behaves exactly as before.
const HYPHA_URL = (process.env["LEASH_BROKER_HYPHA_URL"] ?? "").replace(/\/+$/, "");
const OVERFLOW_ENABLED = HYPHA_URL.length > 0;
/** Shed a same-alias request once this many are already waiting locally (depth gate). */
const OVERFLOW_DEPTH = Number(process.env["LEASH_BROKER_OVERFLOW_DEPTH"] ?? 2);
let shed = 0; // depth-triggered sheds
let availabilityRouted = 0; // alias-not-served-locally routes
let overflowFailures = 0; // overflow attempted but fell through / broke mid-stream

interface Waiter {
  resolve: () => void;
  priority: string;
  seq: number;
  at: number;
}

/** Per-alias slot: at most one in-flight, the rest wait by priority+aging. */
const slots = new Map<string, { busy: boolean; queue: Waiter[] }>();
let seqCounter = 0;
let served = 0;

function slot(alias: string) {
  let s = slots.get(alias);
  if (!s) {
    s = { busy: false, queue: [] };
    slots.set(alias, s);
  }
  return s;
}

/** Acquire the alias's slot; resolves when it's this request's turn. Returns a release fn. */
function acquire(alias: string, priority: string): Promise<() => void> {
  const s = slot(alias);
  const release = (): void => {
    // Pick the next waiter by aged priority (lower effective rank wins; FIFO tiebreak).
    if (s.queue.length === 0) {
      s.busy = false;
      return;
    }
    const now = Date.now();
    let best = 0;
    for (let i = 1; i < s.queue.length; i++) {
      const a = s.queue[i] as Waiter;
      const b = s.queue[best] as Waiter;
      const ea = (RANK[a.priority] ?? 0) - Math.floor((now - a.at) / AGING_MS);
      const eb = (RANK[b.priority] ?? 0) - Math.floor((now - b.at) / AGING_MS);
      if (ea < eb || (ea === eb && a.seq < b.seq)) best = i;
    }
    const next = s.queue.splice(best, 1)[0] as Waiter;
    next.resolve(); // slot stays busy; the new holder releases next
  };
  if (!s.busy) {
    s.busy = true;
    return Promise.resolve(release);
  }
  return new Promise<() => void>((resolve) => {
    s.queue.push({ resolve: () => resolve(release), priority, seq: seqCounter++, at: Date.now() });
  });
}

/** Read a request body fully into a Buffer. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The model alias from a JSON body, or null (non-JSON / no model → not serialized). */
function aliasOf(body: Buffer, contentType: string): string | null {
  if (!/application\/json/i.test(contentType)) return null;
  try {
    const m = (JSON.parse(body.toString("utf8")) as { model?: string }).model;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}

/** Default priority by path when the client doesn't tag the request. */
function defaultPriority(path: string): string {
  if (path.includes("/embeddings")) return "inline";
  return "interactive";
}

interface Cached<T> {
  value: T;
  at: number;
}
let modelsCache: Cached<Set<string>> | null = null;
let peersCache: Cached<Array<{ live?: boolean; warmModels?: string[] }>> | null = null;

/** Aliases the LOCAL serve actually serves (from /v1/models), cached ~5s. */
async function localAliases(): Promise<Set<string>> {
  if (modelsCache && Date.now() - modelsCache.at < 5000) return modelsCache.value;
  try {
    const r = await undiciFetch(`${UPSTREAM}/v1/models`, { dispatcher });
    const j = (await r.json()) as { data?: Array<{ id?: string }> };
    const set = new Set((j.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x)));
    modelsCache = { value: set, at: Date.now() };
    return set;
  } catch {
    // Transient /v1/models blip: reuse last-known (empty on cold start → availability-route to a warm peer).
    return modelsCache?.value ?? new Set<string>();
  }
}

/** Live peers from the Hypha shim with their warm aliases, cached ~2s. */
async function hyphaPeers(): Promise<Array<{ live?: boolean; warmModels?: string[] }>> {
  if (peersCache && Date.now() - peersCache.at < 2000) return peersCache.value;
  try {
    const r = await undiciFetch(`${HYPHA_URL}/peers`, { dispatcher });
    const j = (await r.json()) as { peers?: Array<{ live?: boolean; warmModels?: string[] }> };
    peersCache = { value: j.peers ?? [], at: Date.now() };
    return peersCache.value;
  } catch {
    return [];
  }
}

/**
 * Should this alias overflow to a peer right now? Two OR'd triggers, both requiring a
 * live peer that holds the alias WARM (never pay cold-start on the request path):
 *   · availabilityRouted — the alias isn't served locally at all
 *   · shed — the local alias queue is already ≥ OVERFLOW_DEPTH deep
 */
async function overflowReason(alias: string): Promise<"shed" | "availabilityRouted" | null> {
  const warm = (await hyphaPeers()).some((p) => p.live && (p.warmModels ?? []).includes(alias));
  if (!warm) return null;
  if (!(await localAliases()).has(alias)) return "availabilityRouted";
  const depth = slots.get(alias)?.queue.length ?? 0;
  return depth >= OVERFLOW_DEPTH ? "shed" : null;
}

/**
 * Forward a chat completion to the Hypha shim, streaming the SSE back. Returns:
 *   · "served"      — relayed a 200 to completion
 *   · "fallthrough" — peer couldn't serve before any byte → caller serves locally (never drop)
 *   · "midstream"   — broke after bytes were sent → ended truthfully (can't re-route)
 * On client disconnect the upstream fetch is aborted (via `signal`), so hypha's shim cancels
 * its delegated decode rather than draining it — safe on the current 0.13.x SDK line.
 */
async function forwardToHypha(
  url: string,
  body: Buffer,
  fwd: Record<string, string>,
  res: http.ServerResponse,
  isOpen: () => boolean,
  signal: AbortSignal,
): Promise<"served" | "fallthrough" | "midstream"> {
  let headSent = false;
  try {
    const up = await undiciFetch(`${HYPHA_URL}${url}`, { method: "POST", headers: fwd, body, dispatcher, signal });
    if (!up.ok) {
      try {
        await up.body?.cancel();
      } catch {
        /* nothing to drain on an error response */
      }
      return "fallthrough";
    }
    const outHeaders: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "content-length") outHeaders[k] = v;
    });
    if (isOpen()) {
      res.writeHead(up.status, outHeaders);
      headSent = true;
    }
    if (up.body) {
      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isOpen()) {
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>((r) => res.once("drain", () => r())).catch(() => undefined);
          }
        }
      }
    }
    if (isOpen()) res.end();
    return "served";
  } catch {
    if (!headSent) return "fallthrough";
    if (isOpen()) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    return "midstream";
  }
}

const stats = (): string =>
  JSON.stringify({
    upstream: UPSTREAM,
    served,
    overflow: { enabled: OVERFLOW_ENABLED, hyphaUrl: HYPHA_URL || null, depth: OVERFLOW_DEPTH, shed, availabilityRouted, overflowFailures },
    aliases: Object.fromEntries([...slots].map(([a, s]) => [a, { busy: s.busy, queued: s.queue.length }])),
  });

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (url === "/__broker/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(stats());
    return;
  }

  const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req).catch(() => Buffer.alloc(0));
  const contentType = String(req.headers["content-type"] ?? "");
  const alias = aliasOf(body, contentType);
  const priority = String(req.headers["x-leash-priority"] ?? defaultPriority(url));

  let clientOpen = true;
  // Abort the upstream serve fetch when the client leaves: the serve's cancel-bridge turns the
  // dropped connection into cancel({ requestId }), stopping the decode and freeing the slot
  // (safe on the current 0.13.x SDK line). Fires on normal end too — harmless once the body is fully read.
  const clientGone = new AbortController();
  res.on("close", () => {
    clientOpen = false;
    clientGone.abort();
  });

  // Forward headers verbatim minus hop-by-hop / length (undici recomputes).
  const fwd: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection", "x-leash-priority"].includes(k.toLowerCase())) continue;
    if (typeof v === "string") fwd[k] = v;
  }

  // Mesh overflow: decide BEFORE taking a local slot (the whole point — don't queue locally
  // when a warm peer can take it). Only chat completions; the shim speaks nothing else.
  if (OVERFLOW_ENABLED && alias && method === "POST" && url.includes("/chat/completions")) {
    const reason = await overflowReason(alias);
    if (reason) {
      const outcome = await forwardToHypha(url, body, fwd, res, () => clientOpen, clientGone.signal);
      if (outcome === "served") {
        if (reason === "shed") shed++;
        else availabilityRouted++;
        served++;
        return;
      }
      overflowFailures++;
      // "midstream" already ended the response truthfully; "fallthrough" continues to local.
      if (outcome === "midstream") return;
    }
  }

  // Non-aliased traffic (model list, multipart audio, etc.) passes through unqueued —
  // those endpoints don't collide on a chat/vision context.
  const release = alias ? await acquire(alias, priority) : null;

  // If the client gave up while waiting in the queue, don't bother the serve — just
  // free the slot for the next waiter. (Avoids burning a decode on an abandoned request.)
  if (release && !clientOpen) {
    release();
    return;
  }

  try {
    const upstream = await undiciFetch(`${UPSTREAM}${url}`, {
      method,
      headers: fwd,
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
      dispatcher,
      // Abort the serve fetch when the client leaves → the serve cancel-bridge cancels the
      // decode and frees the slot (safe on the current 0.13.x SDK line). The read loop below is the fallback for
      // bytes already in flight before the abort lands.
      signal: clientGone.signal,
    });

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-length") return;
      outHeaders[k] = v;
    });
    if (clientOpen) res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      // Stream upstream → client. If the client left, the upstream fetch is being aborted
      // (clientGone) so this read loop ends with an abort error (caught below) and the serve
      // cancels — we no longer drain the whole decode.
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientOpen) {
          if (!res.write(Buffer.from(value))) {
            // Respect backpressure when the client is still reading.
            await new Promise<void>((r) => res.once("drain", r)).catch(() => undefined);
          }
        }
      }
    }
    if (clientOpen) res.end();
    served++;
  } catch (err) {
    if (clientOpen) {
      try {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `broker: upstream failed: ${err instanceof Error ? err.message : err}` } }));
      } catch {
        /* headers already sent */
      }
    }
  } finally {
    if (release) release();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🪢 leash-broker on :${PORT} → ${UPSTREAM} (per-alias serialize · priority+aging · cancel-on-disconnect)`);
});

const quit = (): void => {
  server.close();
  console.log("🪢 leash-broker down");
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
