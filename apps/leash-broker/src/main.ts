/**
 * leash-broker — a cross-process priority queue in front of `qvac serve`.
 *
 *   npm run broker            (from repo root; or started from /services)
 *
 * The serve's llm-llamacpp addon serializes inference per model context and REJECTS
 * concurrent same-alias requests (`Cannot set new job…` → 500) rather than queuing them
 * (per QVAC's HTTP-server integration doc). Every serve client (web chat route, the
 * compaction/dream/research children, the watcher) is a separate OS process, so an
 * in-process mutex can't coordinate them. This standalone reverse proxy is the single
 * chokepoint that does:
 *
 *   · per-ALIAS serialization (concurrency 1 per model; different aliases run parallel)
 *   · cross-alias PRIORITY with AGING (interactive > inline > background; a starved
 *     background request's effective priority rises with wait time)
 *   · WEDGE-SAFETY, centralized — on client disconnect it NEVER aborts the upstream
 *     serve (the GPU-wedge rule); it drains the serve to completion, then frees the slot
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

const stats = (): string =>
  JSON.stringify({
    upstream: UPSTREAM,
    served,
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
  res.on("close", () => {
    clientOpen = false;
  });

  // Non-aliased traffic (model list, multipart audio, etc.) passes through unqueued —
  // those endpoints don't collide on a chat/vision context.
  const release = alias ? await acquire(alias, priority) : null;

  // If the client gave up while waiting in the queue, don't bother the serve — just
  // free the slot for the next waiter. (Avoids burning a decode on an abandoned request.)
  if (release && !clientOpen) {
    release();
    return;
  }

  // Forward headers verbatim minus hop-by-hop / length (undici recomputes).
  const fwd: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection", "x-leash-priority"].includes(k.toLowerCase())) continue;
    if (typeof v === "string") fwd[k] = v;
  }

  try {
    const upstream = await undiciFetch(`${UPSTREAM}${url}`, {
      method,
      headers: fwd,
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
      dispatcher,
      // DELIBERATELY no abort signal tied to the client — never abort the serve
      // mid-decode (GPU-wedge rule). If the client leaves, we drain upstream below.
    });

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-length") return;
      outHeaders[k] = v;
    });
    if (clientOpen) res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      // Stream upstream → client. If the client has gone, keep reading to DRAIN the
      // serve to completion (so the next queued request isn't blocked / the serve isn't
      // left mid-job) — but never abort it.
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
  console.log(`🪢 leash-broker on :${PORT} → ${UPSTREAM} (per-alias serialize · priority+aging · wedge-safe drain)`);
});

const quit = (): void => {
  server.close();
  console.log("🪢 leash-broker down");
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
