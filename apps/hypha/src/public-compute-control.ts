import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { networkInterfaces } from "node:os";
import { createConnection, createServer, type Server } from "node:net";
import Hyperswarm from "hyperswarm";
import SecretStream from "@hyperswarm/secret-stream";
import type { AuditLog } from "@mycelium/shared";
import type { PublicProviderAdvert } from "@mycelium/mesh";
import type { ForwardChunk, ForwardFrame, ForwardHandler } from "./forward-control.ts";

interface PeerStream {
  on(event: string, listener: (...args: any[]) => void): this;
  write(data: string | Buffer): boolean;
  destroy(err?: Error): void;
}
interface PeerInfoLike { publicKey?: Buffer }
type PublicSwarm = Hyperswarm & { keyPair: { publicKey: Buffer; secretKey: Buffer }; listen(): Promise<void>; joinPeer(key: Buffer): void };

export type PublicJobFailure = "invalid_request" | "authentication_failure" | "replay" | "capability_mismatch" | "overloaded_provider" | "timeout" | "cancellation" | "inference_failure";
export interface PublicJobRequest {
  version: 1; type: "job"; jobId: string; nonce: string; issuedAt: number;
  providerId: string; requesterId: string; endpoint: "/v1/chat/completions"; body: Record<string, unknown>;
}
type PublicCancel = { version: 1; type: "cancel"; jobId: string; requesterId: string };
type PublicFrame =
  | { version: 1; type: "accepted"; jobId: string; providerId: string; transportKey: string; queueMs: number }
  | ({ version: 1; jobId: string } & Omit<ForwardChunk, "id">)
  | { version: 1; type: "done"; jobId: string; stats: Record<string, unknown> }
  | { version: 1; type: "error"; jobId: string; code: PublicJobFailure; error: string };

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i;
const HEX_32 = /^[0-9a-f]{64}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const encode = (v: PublicJobRequest | PublicCancel | PublicFrame): string => JSON.stringify(v) + "\n";

/** Persisted, bounded replay cache: a daemon restart does not make a captured job valid again. */
export class PublicReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly file?: string, private readonly ttlMs = 24 * 60 * 60 * 1000, private readonly max = 20_000) {
    if (!file || !existsSync(file)) return;
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as Array<[string, number]>;
      const now = Date.now();
      for (const [key, expiry] of rows) if (typeof key === "string" && typeof expiry === "number" && expiry > now) this.seen.set(key, expiry);
    } catch { /* fail closed for malformed entries by starting empty; file is rewritten on first use */ }
  }
  accept(requesterId: string, jobId: string, nonce: string, now = Date.now()): boolean {
    this.prune(now);
    // Enforce both protocol identities independently: rotating a nonce cannot revive a job ID,
    // and rotating a job ID cannot reuse a captured nonce.
    const jobKey = createHash("sha256").update(`job:${requesterId}:${jobId}`).digest("hex");
    const nonceKey = createHash("sha256").update(`nonce:${requesterId}:${nonce}`).digest("hex");
    if (this.seen.has(jobKey) || this.seen.has(nonceKey)) return false;
    this.seen.set(jobKey, now + this.ttlMs);
    this.seen.set(nonceKey, now + this.ttlMs);
    while (this.seen.size > this.max * 2) this.seen.delete(this.seen.keys().next().value as string);
    this.save();
    return true;
  }
  private prune(now: number): void { for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key); }
  private save(): void { if (this.file) try { writeFileSync(this.file, JSON.stringify([...this.seen])); } catch { /* audit path still records replay decisions */ } }
}

export interface PublicComputeServerDeps {
  seed: string; audit: AuditLog; handler: ForwardHandler; replay: PublicReplayGuard;
  providerIds: () => Set<string>;
  validateCapability: (body: Record<string, unknown>) => { ok: true; alias: string; contextTokens: number; outputLimit: number } | { ok: false; error: string };
  limits: () => { maxConcurrent: number; maxRequestBytes: number; timeoutMs: number; minHeadroomMb: number };
  onAvailabilityChange?: () => void | Promise<void>;
  lanPort: number;
  lanHost: string;
}

export class PublicComputeServer {
  private readonly swarm: PublicSwarm;
  private readonly lanServer: Server;
  private readonly lanConnections = new Set<PeerStream>();
  private readonly inflight = new Map<string, AbortController>();
  private active = 0;
  constructor(private readonly deps: PublicComputeServerDeps) {
    this.swarm = new Hyperswarm({ seed: createHash("sha256").update(`${deps.seed}:public-compute-server`).digest() }) as PublicSwarm;
    this.swarm.on("connection", (conn, info) => this.onConnection(conn as PeerStream, info as PeerInfoLike, "dht"));
    this.lanServer = createServer((socket) => {
      socket.on("error", () => undefined);
      const secure = new SecretStream(false, socket, { keyPair: this.swarm.keyPair }) as unknown as PeerStream & { remotePublicKey?: Buffer };
      this.lanConnections.add(secure);
      secure.on("error", () => undefined);
      secure.on("close", () => this.lanConnections.delete(secure));
      secure.on("connect", () => this.onConnection(secure, { publicKey: secure.remotePublicKey }, "lan"));
    });
    this.lanServer.on("error", (error) => this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: "lan-listener-error", error: error.message } }));
  }
  get transportKey(): string { return this.swarm.keyPair.publicKey.toString("hex"); }
  get lanPort(): number { const address = this.lanServer.address(); return address && typeof address !== "string" ? address.port : 0; }
  lanEndpoints(): Array<{ host: string; port: number }> {
    const port = this.lanPort;
    if (!port) return [];
    const endpoints: Array<{ host: string; port: number }> = [];
    for (const rows of Object.values(networkInterfaces())) for (const row of rows ?? []) {
      if (row.family !== "IPv4" || row.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(row.address)) continue;
      endpoints.push({ host: row.address, port });
    }
    return endpoints.slice(0, 8);
  }
  get inflightCount(): number { return this.active; }
  async ready(): Promise<void> {
    await this.swarm.listen();
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.lanServer.off("listening", ready); reject(error); };
      const ready = () => { this.lanServer.off("error", fail); resolve(); };
      this.lanServer.once("error", fail);
      this.lanServer.once("listening", ready);
      this.lanServer.listen(this.deps.lanPort, this.deps.lanHost);
    });
    this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: "lan-listener-ready", port: this.lanPort, transportKey: this.transportKey } });
  }
  async close(): Promise<void> {
    for (const ac of this.inflight.values()) ac.abort();
    for (const connection of this.lanConnections) connection.destroy();
    this.lanConnections.clear();
    await new Promise<void>((resolve) => this.lanServer.close(() => resolve())).catch(() => undefined);
    await this.swarm.destroy();
  }

  private onConnection(conn: PeerStream, info: PeerInfoLike, connectionTransport: "lan" | "dht"): void {
    // Noise streams can report ECONNRESET during duplicate-dial arbitration or peer teardown.
    // Attach before any validation/destroy path so a rejected public peer cannot crash Hypha.
    conn.on("error", () => undefined);
    const remote = info.publicKey?.toString("hex") ?? "";
    if (!HEX_32.test(remote)) { conn.destroy(new Error("public compute: missing authenticated Noise peer key")); return; }
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > Math.min(MAX_LINE_BYTES, this.deps.limits().maxRequestBytes + 4096)) { conn.destroy(new Error("public compute: request too large")); return; }
      const parts = buffer.split("\n"); buffer = parts.pop() ?? "";
      for (const line of parts) if (line) void this.dispatch(conn, remote, connectionTransport, line);
    });
    conn.on("close", () => {
      for (const [key, ac] of this.inflight) if (key.startsWith(`${remote}:`)) { ac.abort(); this.inflight.delete(key); }
    });
  }

  private error(conn: PeerStream, jobId: string, code: PublicJobFailure, error: string): void { try { conn.write(encode({ version: 1, type: "error", jobId, code, error })); } catch { /* peer gone */ } }

  private async dispatch(conn: PeerStream, remote: string, connectionTransport: "lan" | "dht", line: string): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { this.error(conn, "unknown", "invalid_request", "malformed JSON"); return; }
    if (!isObj(raw)) { this.error(conn, "unknown", "invalid_request", "request must be an object"); return; }
    if (raw["type"] === "cancel") {
      const jobId = typeof raw["jobId"] === "string" ? raw["jobId"] : "";
      if (raw["requesterId"] !== remote) { this.error(conn, jobId, "authentication_failure", "cancel requester does not match Noise identity"); return; }
      const controller = this.inflight.get(`${remote}:${jobId}`);
      if (controller) {
        controller.abort();
        this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: "cancel", jobId, requesterId: remote } });
      }
      return;
    }
    const req = raw as unknown as PublicJobRequest;
    const jobId = typeof req.jobId === "string" ? req.jobId : "unknown";
    if (req.version !== 1 || req.type !== "job" || !JOB_ID.test(jobId) || !HEX_32.test(req.nonce) || req.requesterId !== remote || req.endpoint !== "/v1/chat/completions" || !isObj(req.body)) { this.error(conn, jobId, req.requesterId !== remote ? "authentication_failure" : "invalid_request", "invalid job envelope"); return; }
    if (Math.abs(Date.now() - req.issuedAt) > 60_000) { this.error(conn, jobId, "replay", "job timestamp outside acceptance window"); return; }
    if (!this.deps.providerIds().has(req.providerId)) { this.error(conn, jobId, "authentication_failure", "advertised provider identity is not active on this server"); return; }
    if (!this.deps.replay.accept(remote, jobId, req.nonce)) { this.error(conn, jobId, "replay", "job id/nonce already used"); return; }
    const limits = this.deps.limits();
    if (Buffer.byteLength(line) > limits.maxRequestBytes) { this.error(conn, jobId, "invalid_request", "request exceeds provider byte limit"); return; }
    const cap = this.deps.validateCapability(req.body);
    if (!cap.ok) { this.error(conn, jobId, "capability_mismatch", cap.error); return; }
    const requestedOutput = req.body["max_tokens"] ?? cap.outputLimit;
    if (!Number.isInteger(requestedOutput) || (requestedOutput as number) < 1) { this.error(conn, jobId, "invalid_request", "max_tokens must be a positive integer"); return; }
    if (this.active >= limits.maxConcurrent) { this.error(conn, jobId, "overloaded_provider", "public concurrency limit reached"); return; }
    // The advert is only a short-lived snapshot. Re-check physical headroom at admission so a
    // provider that filled up between discovery and connection fails closed.
    const availableMemoryMb = Math.round(freemem() / 1048576);
    if (availableMemoryMb < limits.minHeadroomMb) {
      this.deps.audit.record({ event: "delegation", modelId: cap.alias, extra: { role: "public-provider", phase: "rejected", jobId, requesterId: remote, code: "overloaded_provider", availableMemoryMb, minHeadroomMb: limits.minHeadroomMb } });
      this.error(conn, jobId, "overloaded_provider", `provider memory headroom ${availableMemoryMb}MB is below ${limits.minHeadroomMb}MB`);
      return;
    }

    const receivedAt = Date.now();
    const ac = new AbortController();
    const key = `${remote}:${jobId}`;
    this.inflight.set(key, ac); this.active++;
    void Promise.resolve(this.deps.onAvailabilityChange?.()).catch(() => undefined);
    const timer = setTimeout(() => ac.abort(new Error("public job timeout")), limits.timeoutMs); timer.unref?.();
    const memBefore = process.memoryUsage().rss;
    const systemUsedBeforeMb = Math.round((totalmem() - freemem()) / 1048576);
    const queueMs = Date.now() - receivedAt;
    conn.write(encode({ version: 1, type: "accepted", jobId, providerId: req.providerId, transportKey: this.transportKey, queueMs }));
    this.deps.audit.record({ event: "delegation", modelId: cap.alias, extra: { role: "public-provider", phase: "accepted", jobId, providerId: req.providerId, requesterId: remote, connectionTransport, queueMs, contextTokens: cap.contextTokens, providerRssMb: Math.round(memBefore / 1048576) } });
    const started = Date.now(); let firstAt = 0; let tokens = 0; let outputBytes = 0; let outputLimited = false; let terminalError = false;
    const maxOutputBytes = Math.min(limits.maxRequestBytes, Math.max(64 * 1024, cap.outputLimit * 64));
    const send = (frame: ForwardFrame): void => {
      try {
        if (frame.type === "chunk") {
          if (outputLimited) return;
          outputBytes += Buffer.byteLength(JSON.stringify(frame));
          if (outputBytes > maxOutputBytes || (frame.data && tokens >= cap.outputLimit)) {
            outputLimited = true;
            terminalError = true;
            ac.abort(new Error("public output limit exceeded"));
            this.error(conn, jobId, "inference_failure", "public output limit exceeded");
            return;
          }
          if (!firstAt) firstAt = Date.now();
          if (frame.data) tokens++;
          if (frame.delta?.tool_calls?.length || frame.delta?.finish_reason) this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: "structured-delta-send", jobId, toolCallCount: frame.delta.tool_calls?.length ?? 0, ...(frame.delta.finish_reason ? { finishReason: frame.delta.finish_reason } : {}) } });
          conn.write(encode({ version: 1, jobId, type: "chunk", data: frame.data, ...(frame.delta ? { delta: frame.delta } : {}) }));
        }
        else if (frame.type === "error") { terminalError = true; this.error(conn, jobId, ac.signal.aborted ? "cancellation" : "inference_failure", frame.error); }
        else {
          const ended = Date.now();
          const stats = { ...(frame.stats ?? {}), jobId, providerId: req.providerId, transportKey: this.transportKey, connectionTransport, queueMs, ttftMs: firstAt ? firstAt - started : 0, totalMs: ended - receivedAt, generationMs: ended - started, tokens, outputBytes, tokensPerSecond: tokens && firstAt ? Number((tokens / Math.max(0.001, (ended - firstAt) / 1000)).toFixed(2)) : 0, providerRssBeforeMb: Math.round(memBefore / 1048576), providerRssAfterMb: Math.round(process.memoryUsage().rss / 1048576), providerSystemUsedBeforeMb: systemUsedBeforeMb, providerSystemUsedAfterMb: Math.round((totalmem() - freemem()) / 1048576) };
          conn.write(encode({ version: 1, type: "done", jobId, stats }));
          this.deps.audit.record({ event: "delegation", modelId: cap.alias, tokens, ttftMs: stats.ttftMs, tokensPerSecond: stats.tokensPerSecond, durationMs: stats.totalMs, extra: { role: "public-provider", phase: "done", ...stats } });
        }
      } catch { ac.abort(); }
    };
    try { await this.deps.handler({ id: jobId, endpoint: req.endpoint, body: { ...req.body, max_tokens: Math.min(requestedOutput as number, cap.outputLimit) } }, send, ac.signal); }
    catch (err) { if (!terminalError) this.error(conn, jobId, ac.signal.aborted ? (ac.signal.reason instanceof Error && ac.signal.reason.message.includes("timeout") ? "timeout" : "cancellation") : "inference_failure", err instanceof Error ? err.message : String(err)); }
    finally {
      clearTimeout(timer); this.inflight.delete(key); this.active--;
      void Promise.resolve(this.deps.onAvailabilityChange?.()).catch(() => undefined);
    }
  }
}

interface ClientPending {
  advert: PublicProviderAdvert; resolveAccepted: (v: { queueMs: number }) => void; rejectAccepted: (error: Error) => void; accepted: Promise<{ queueMs: number }>;
  acceptedReceived: boolean; chunks: ForwardChunk[]; done?: Record<string, unknown>; error?: Error; wake?: () => void;
}

export class PublicComputeClient {
  private readonly swarm: PublicSwarm;
  private readonly connections = new Map<string, PeerStream>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly pending = new Map<string, ClientPending>();
  private readonly buffers = new Map<string, string>();
  private readonly connectionKinds = new Map<string, "lan" | "dht">();
  readonly requesterId: string;
  constructor(seed: string, private readonly audit?: AuditLog) {
    this.swarm = new Hyperswarm({ seed: createHash("sha256").update(`${seed}:public-compute-client`).digest() }) as PublicSwarm;
    this.requesterId = this.swarm.keyPair.publicKey.toString("hex");
    this.swarm.on("connection", (conn, info) => this.bind(conn as PeerStream, info as PeerInfoLike, "dht"));
  }
  private bind(conn: PeerStream, info: PeerInfoLike, kind: "lan" | "dht"): void {
    conn.on("error", () => undefined);
    const key = info.publicKey?.toString("hex") ?? "";
    if (!HEX_32.test(key)) { conn.destroy(); return; }
    const existing = this.connections.get(key); if (existing) { conn.destroy(); return; }
    this.connections.set(key, conn); this.buffers.set(key, ""); this.connectionKinds.set(key, kind);
    conn.on("data", (chunk) => this.onData(key, chunk));
    const drop = () => { if (this.connections.get(key) === conn) { this.connections.delete(key); this.connectionKinds.delete(key); } for (const p of this.pending.values()) if (p.advert.transportKey === key) { p.error = new Error("unreachable_provider: connection dropped"); if (!p.acceptedReceived) p.rejectAccepted(p.error); p.wake?.(); } };
    conn.on("error", drop); conn.on("close", drop);
    for (const wake of this.waiting.get(key) ?? []) wake(); this.waiting.delete(key);
  }
  private async connectLan(advert: PublicProviderAdvert, timeoutMs: number): Promise<boolean> {
    const key = Buffer.from(advert.transportKey, "hex");
    for (const endpoint of advert.lanEndpoints) {
      const connected = await new Promise<boolean>((resolve) => {
        let settled = false;
        const raw = createConnection({ host: endpoint.host, port: endpoint.port });
        raw.on("error", () => finish(false));
        const secure = new SecretStream(true, raw, { keyPair: this.swarm.keyPair, remotePublicKey: key }) as unknown as PeerStream & { remotePublicKey?: Buffer };
        secure.on("error", () => finish(false));
        const timer = setTimeout(() => finish(false), Math.min(2_500, timeoutMs)); timer.unref?.();
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (!ok) secure.destroy();
          resolve(ok);
        };
        secure.on("connect", () => {
          if (!secure.remotePublicKey?.equals(key)) return finish(false);
          this.bind(secure, { publicKey: secure.remotePublicKey }, "lan");
          finish(this.connections.has(advert.transportKey));
        });
      });
      if (connected) return true;
    }
    return false;
  }
  private onData(key: string, chunk: Buffer): void {
    let buffer = (this.buffers.get(key) ?? "") + chunk.toString("utf8");
    const parts = buffer.split("\n"); buffer = parts.pop() ?? ""; this.buffers.set(key, buffer);
    for (const line of parts) {
      let frame: PublicFrame; try { frame = JSON.parse(line) as PublicFrame; } catch { continue; }
      const p = this.pending.get(frame.jobId); if (!p) continue;
      if (frame.type === "accepted") {
        if (frame.providerId !== p.advert.providerId || frame.transportKey !== p.advert.transportKey || key !== p.advert.transportKey) { p.error = new Error("authentication_failure: provider identity mismatch"); if (!p.acceptedReceived) p.rejectAccepted(p.error); p.wake?.(); continue; }
        p.acceptedReceived = true;
        p.resolveAccepted({ queueMs: frame.queueMs });
      } else if (frame.type === "chunk") {
        p.chunks.push({ id: frame.jobId, type: "chunk", data: frame.data, ...(frame.delta ? { delta: frame.delta } : {}) });
        if (frame.delta?.tool_calls?.length || frame.delta?.finish_reason) this.audit?.record({ event: "delegation", extra: { role: "public-consumer", phase: "structured-delta-receive", jobId: frame.jobId, toolCallCount: frame.delta.tool_calls?.length ?? 0, ...(frame.delta.finish_reason ? { finishReason: frame.delta.finish_reason } : {}) } });
        p.wake?.();
      }
      else if (frame.type === "done") { p.done = frame.stats; p.wake?.(); }
      else { p.error = new Error(`${frame.code}: ${frame.error}`); if (!p.acceptedReceived) p.rejectAccepted(p.error); p.wake?.(); }
    }
  }
  async connect(advert: PublicProviderAdvert, timeoutMs = 20_000): Promise<number> {
    const existing = this.connections.get(advert.transportKey); if (existing) return 0;
    const started = Date.now();
    if (await this.connectLan(advert, timeoutMs)) return Date.now() - started;
    const key = Buffer.from(advert.transportKey, "hex"); this.swarm.joinPeer(key);
    await Promise.race([
      new Promise<void>((resolve) => { const list = this.waiting.get(advert.transportKey) ?? []; list.push(resolve); this.waiting.set(advert.transportKey, list); }),
      new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("unreachable_provider: connect timeout")), timeoutMs); t.unref?.(); }),
    ]);
    if (!this.connections.has(advert.transportKey)) throw new Error("authentication_failure: connected Noise key does not match advert");
    return Date.now() - started;
  }
  async probe(advert: PublicProviderAdvert): Promise<number> { return this.connect(advert, 8_000); }
  async *forwardFrames(advert: PublicProviderAdvert, body: Record<string, unknown>, opts: { jobId?: string; timeoutMs?: number } = {}): AsyncGenerator<ForwardChunk, Record<string, unknown>> {
    const requesterRssBeforeMb = Math.round(process.memoryUsage().rss / 1048576);
    const requesterSystemUsedBeforeMb = Math.round((totalmem() - freemem()) / 1048576);
    const connectionMs = await this.connect(advert);
    const jobId = opts.jobId ?? randomUUID();
    let resolveAccepted!: (v: { queueMs: number }) => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<{ queueMs: number }>((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject; });
    const pending: ClientPending = { advert, resolveAccepted, rejectAccepted, accepted, acceptedReceived: false, chunks: [] };
    this.pending.set(jobId, pending);
    const req: PublicJobRequest = { version: 1, type: "job", jobId, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now(), providerId: advert.providerId, requesterId: this.requesterId, endpoint: "/v1/chat/completions", body };
    this.connections.get(advert.transportKey)!.write(encode(req));
    const started = Date.now(); let firstAt = 0; let acceptedInfo: { queueMs: number } | undefined;
    const deadlineAt = started + (opts.timeoutMs ?? 180_000);
    let completed = false;
    try {
      for (;;) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new Error("timeout: public job deadline exceeded");
        if (!acceptedInfo) acceptedInfo = await Promise.race([accepted, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("timeout: provider did not accept job")), Math.min(30_000, remaining)); t.unref?.(); })]);
        // A provider commonly writes the final content/tool delta and its terminal frame in one
        // transport batch. Drain every queued chunk before observing either `error` or `done` so a
        // valid prefix is never lost merely because the terminal condition arrived alongside it.
        if (pending.chunks.length) { const next = pending.chunks.shift()!; if (!firstAt) firstAt = Date.now(); yield next; continue; }
        if (pending.error) throw pending.error;
        if (pending.done) break;
        await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error("timeout: public stream stalled")), Math.min(60_000, remaining)); pending.wake = () => { clearTimeout(t); pending.wake = undefined; resolve(); }; t.unref?.(); });
      }
      completed = true;
      const finished = Date.now();
      const stats: Record<string, unknown> = { ...(pending.done ?? {}), jobId, route: "public", connectionTransport: this.connectionKinds.get(advert.transportKey) ?? "unknown", discoveryMs: 0, connectionMs, requesterTtftMs: firstAt ? firstAt - started : 0, requesterTotalMs: finished - started, requesterRssBeforeMb, requesterRssAfterMb: Math.round(process.memoryUsage().rss / 1048576), requesterSystemUsedBeforeMb, requesterSystemUsedAfterMb: Math.round((totalmem() - freemem()) / 1048576), queueMs: acceptedInfo?.queueMs ?? 0 };
      this.audit?.record({ event: "delegation", tokens: Number(stats["tokens"] ?? 0), ttftMs: Number(stats["requesterTtftMs"] ?? 0), tokensPerSecond: Number(stats["tokensPerSecond"] ?? 0), durationMs: Number(stats["requesterTotalMs"] ?? 0), extra: { role: "public-consumer", phase: "done", providerId: advert.providerId, transportKey: advert.transportKey, ...stats } });
      return stats;
    } finally {
      if (!completed) this.cancel(advert, jobId);
      this.pending.delete(jobId);
    }
  }
  cancel(advert: PublicProviderAdvert, jobId: string): void { this.connections.get(advert.transportKey)?.write(encode({ version: 1, type: "cancel", jobId, requesterId: this.requesterId })); }
  async close(): Promise<void> { await this.swarm.destroy(); }
}
