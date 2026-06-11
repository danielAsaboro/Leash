import { createHash } from "node:crypto";
import Hyperswarm from "hyperswarm";
import type { AuditLog } from "@mycelium/shared";

// Forward transport (consumer → provider) for borrowing the modalities SDK delegation can't carry —
// vision (and later embeddings/STT/TTS). One long-lived per-pair topic carries an OpenAI request
// whose media rides INLINE in the body (base64 data-URLs); the provider runs it on its OWN local
// serve and streams the answer back frame-by-frame. The path problem of delegated attachments
// (path-only, read on the worker) vanishes because the bytes are in the body.
//
// Modeled on payment-control.ts: the CLIENT holds ONE persistent Hyperswarm (stable derived seed →
// warm DHT/NAT state) and ONE multiplexed connection per provider, reused across requests. The
// SERVER keeps each connection open and treats every newline-delimited line as an independent
// request, so the connection multiplexes with no server-side change. Cold cross-host holepunch costs
// tens of seconds, so only the first connect gambles (retried with a fresh DHT lookup); warm()
// pre-connects in the background so the cold start is absorbed before the user triggers a borrow.

interface PeerStream {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error" | "close" | "end", listener: (...args: unknown[]) => void): this;
  write(data: string | Buffer): boolean;
  end(): void;
  destroy(err?: Error): void;
}

/** Hyperswarm passes a PeerInfo as the 2nd connection arg; we only need its key + topics. */
interface PeerInfoLike {
  publicKey?: Buffer;
  topics?: Buffer[];
}

const TOPIC_PREFIX = "hypha-forward-v1";

/** One forwarded OpenAI request. `endpoint` selects the serve route; media rides inline in `body`. */
export interface ForwardRequest {
  id: string;
  endpoint: string;
  body: unknown;
}

/** Streamed response frames for one request id, multiplexed over the shared connection. */
export type ForwardFrame =
  | { id: string; type: "chunk"; data: string }
  | { id: string; type: "done"; stats?: Record<string, unknown> }
  | { id: string; type: "error"; error: string };

// Connect/timeout budgets. Only the first connect gambles on a cold holepunch (retried with a fresh
// lookup). Once warm, a forwarded request's FIRST frame can still be slow — the provider loads/decodes
// media + produces the first token — so that budget is generous; the inter-frame budget (steady token
// stream) is shorter and fail-fast (a long gap means the held connection went half-open).
const CONNECT_ATTEMPT_MS = Number(process.env["HYPHA_FORWARD_CONNECT_ATTEMPT_MS"] ?? 25_000);
const CONNECT_ATTEMPTS = Number(process.env["HYPHA_FORWARD_CONNECT_ATTEMPTS"] ?? 6);
const FIRST_FRAME_MS = Number(process.env["HYPHA_FORWARD_FIRST_FRAME_MS"] ?? 120_000);
const IDLE_FRAME_MS = Number(process.env["HYPHA_FORWARD_IDLE_FRAME_MS"] ?? 60_000);
// Force remote (DHT-holepunch) dials, disabling hyperdht's same-public-IP "LAN shortcut" — the
// daemon default (the shortcut is broken in-process). A SAME-MACHINE loopback (the smoke) must turn
// this OFF so the local path is allowed, the way the spike connected two swarms on one host.
const FORCE_REMOTE_DIAL = (process.env["HYPHA_FORWARD_FORCE_REMOTE"] ?? "1") !== "0";

function topicForPair(providerPublicKey: string, consumerPublicKey: string): Buffer {
  return createHash("sha256").update(`${TOPIC_PREFIX}:${providerPublicKey}:${consumerPublicKey}`).digest();
}

function encodeLine(value: ForwardRequest | ForwardFrame): string {
  return JSON.stringify(value) + "\n";
}

function parseLines(buffer: string): { rest: string; lines: string[] } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { rest, lines: parts.filter(Boolean) };
}

// ── server ───────────────────────────────────────────────────────────────────────────────────────

/** Streams the answer for one forwarded request by calling `send` with chunk/done/error frames. */
export type ForwardHandler = (req: ForwardRequest, send: (frame: ForwardFrame) => void) => Promise<void>;

export interface ForwardControlServerDeps {
  seed: string;
  audit: AuditLog;
  handler: ForwardHandler;
}

export class ForwardControlServer {
  private readonly swarm: Hyperswarm;
  private providerPublicKey: string | null = null;
  private readonly joinedTopics = new Map<string, Buffer>();

  constructor(private readonly deps: ForwardControlServerDeps) {
    // CRITICAL: derive a DISTINCT swarm identity. The raw device seed is already the QVAC SDK worker's
    // hyperdht identity (and the payment-control server derives its own); two hyperdht servers under
    // one keypair make DHT routing for that key flap between sockets. Discovery is purely via the
    // per-pair topic announce, so this swarm's key never needs to equal the gossiped provider key.
    const seed = createHash("sha256").update(`${deps.seed}:forward-server`).digest();
    this.swarm = new Hyperswarm({ seed });
    this.swarm.on("connection", (conn, info) => this.handleConnection(conn as PeerStream, info as PeerInfoLike | undefined));
  }

  async ready(): Promise<void> {
    await this.swarm.flush();
  }

  /** Join/leave per-pair topics so this provider only accepts forwards from its allowed consumers. */
  async updateAllowedConsumers(providerPublicKey: string, consumers: Set<string>): Promise<void> {
    this.providerPublicKey = providerPublicKey;
    const desired = new Map<string, Buffer>();
    for (const consumer of consumers) desired.set(consumer, topicForPair(providerPublicKey, consumer));
    for (const [consumer, topic] of this.joinedTopics) {
      if (desired.has(consumer)) continue;
      await this.swarm.leave(topic).catch(() => undefined);
      this.joinedTopics.delete(consumer);
    }
    for (const [consumer, topic] of desired) {
      if (this.joinedTopics.has(consumer)) continue;
      this.swarm.join(topic, { server: true, client: false });
      this.joinedTopics.set(consumer, topic);
      this.deps.audit.record({ event: "note", extra: { role: "forward", phase: "server-topic-join", consumer: consumer.slice(0, 16), topic: topic.toString("hex").slice(0, 16) } });
    }
    await this.swarm.flush();
  }

  async close(): Promise<void> {
    await this.swarm.destroy();
  }

  private handleConnection(conn: PeerStream, info?: PeerInfoLike): void {
    const remote = info?.publicKey?.toString("hex").slice(0, 16) ?? "unknown";
    this.deps.audit.record({ event: "note", extra: { role: "forward", phase: "server-conn-open", remote } });
    let buffer = "";
    conn.on("error", (err) => this.deps.audit.record({ event: "note", extra: { role: "forward", phase: "server-conn-error", remote, error: err instanceof Error ? err.message : String(err) } }));
    conn.on("close", () => this.deps.audit.record({ event: "note", extra: { role: "forward", phase: "server-conn-close", remote } }));
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parsed = parseLines(buffer);
      buffer = parsed.rest;
      for (const line of parsed.lines) void this.dispatch(conn, line);
    });
  }

  /** Parse one request line and stream its answer back. Each frame is tagged with the request id, so
   *  many in-flight forwards multiplex over the one connection. */
  private async dispatch(conn: PeerStream, line: string): Promise<void> {
    let req: ForwardRequest;
    try {
      req = JSON.parse(line) as ForwardRequest;
    } catch {
      return; // unparseable frame — there is no id to reply to.
    }
    const send = (frame: ForwardFrame): void => {
      try { conn.write(encodeLine(frame)); } catch { /* peer gone mid-stream — best effort */ }
    };
    this.deps.audit.record({ event: "note", extra: { role: "forward", phase: "server-recv", id: req.id, endpoint: req.endpoint } });
    try {
      await this.deps.handler(req, send);
    } catch (err) {
      send({ id: req.id, type: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ── client ───────────────────────────────────────────────────────────────────────────────────────

/** Feeds one in-flight forwarded request's frames into its async-generator consumer. */
interface StreamSink {
  onChunk: (data: string) => void;
  onDone: (stats?: Record<string, unknown>) => void;
  onError: (err: Error) => void;
}

/** One persistent, multiplexed connection to a single provider, keyed by its per-pair topic. */
interface ProviderConn {
  providerKey: string;
  topic: Buffer;
  topicHex: string;
  conn: PeerStream | null;
  buffer: string;
  /** In-flight requests by id → stream sink, multiplexed over the one connection. */
  pending: Map<string, StreamSink>;
  connectWaiters: Array<{ resolve: () => void }>;
  connecting: Promise<void> | null;
  joined: boolean;
  remoteKey: string | null;
}

export class ForwardControlClient {
  private swarm: Hyperswarm | null = null;
  private readonly conns = new Map<string, ProviderConn>();
  private readonly byTopic = new Map<string, string>();
  private readonly byRemote = new Map<string, ProviderConn>();
  private closed = false;

  constructor(
    private readonly consumerPublicKey: () => string | null,
    private readonly seedHex: string,
    private readonly audit?: AuditLog,
  ) {}

  private selfKey(): string {
    const key = this.consumerPublicKey();
    if (!key) throw new Error("forward: consumer public key unavailable");
    return key;
  }

  private ensureSwarm(): Hyperswarm {
    if (this.swarm) return this.swarm;
    const seed = createHash("sha256").update(`${this.seedHex}:forward-client`).digest();
    const swarm = new Hyperswarm({ seed });
    // Force localConnection:false on every dial. hyperdht's same-public-IP "LAN shortcut" aborts the
    // WHOLE connect if its LAN ping fails, which breaks dials inside the daemon (proven in
    // payment-control); the normal punch path connects in <1s. hyperswarm exposes no per-connect
    // opts, so wrap the dht.connect of this swarm's OWN dht instance. Skipped on same-machine loopback.
    if (FORCE_REMOTE_DIAL) {
      const dht = (swarm as unknown as { dht: { connect: (key: Buffer, opts?: Record<string, unknown>) => unknown } }).dht;
      const origConnect = dht.connect.bind(dht);
      dht.connect = (key: Buffer, opts?: Record<string, unknown>) => origConnect(key, { ...opts, localConnection: false });
    }
    swarm.on("connection", (raw, info) => this.onConnection(raw as PeerStream, info as PeerInfoLike | undefined));
    this.swarm = swarm;
    return swarm;
  }

  private providerConn(providerKey: string): ProviderConn {
    const existing = this.conns.get(providerKey);
    if (existing) return existing;
    const topic = topicForPair(providerKey, this.selfKey());
    const topicHex = topic.toString("hex");
    const pc: ProviderConn = { providerKey, topic, topicHex, conn: null, buffer: "", pending: new Map(), connectWaiters: [], connecting: null, joined: false, remoteKey: null };
    this.conns.set(providerKey, pc);
    this.byTopic.set(topicHex, providerKey);
    return pc;
  }

  private onConnection(conn: PeerStream, info: PeerInfoLike | undefined): void {
    const matched = this.matchConn(info);
    const remote = info?.publicKey?.toString("hex").slice(0, 16) ?? "unknown";
    if (!matched || matched.pc.conn) {
      this.audit?.record({ event: "note", extra: { role: "forward", phase: "client-conn-drop", remote, reason: matched ? "duplicate" : "unmatched" } });
      try { conn.destroy(); } catch { /* best effort */ }
      return;
    }
    this.audit?.record({ event: "note", extra: { role: "forward", phase: "client-conn-bind", remote, via: matched.via, provider: matched.pc.providerKey.slice(0, 16) } });
    this.bind(matched.pc, conn, info);
  }

  /** Route an incoming connection to the provider it belongs to (topic → remote-key → single-pending). */
  private matchConn(info: PeerInfoLike | undefined): { pc: ProviderConn; via: string } | null {
    for (const t of info?.topics ?? []) {
      const provider = this.byTopic.get(t.toString("hex"));
      const pc = provider ? this.conns.get(provider) : undefined;
      if (pc) return { pc, via: "topic" };
    }
    const remote = info?.publicKey?.toString("hex");
    if (remote) {
      const pc = this.byRemote.get(remote);
      if (pc) return { pc, via: "remote-key" };
    }
    const awaiting = [...this.conns.values()].filter((pc) => !pc.conn && pc.connecting);
    return awaiting.length === 1 ? { pc: awaiting[0]!, via: "single-pending" } : null;
  }

  private bind(pc: ProviderConn, conn: PeerStream, info: PeerInfoLike | undefined): void {
    pc.conn = conn;
    pc.buffer = "";
    const remote = info?.publicKey?.toString("hex");
    if (remote) { pc.remoteKey = remote; this.byRemote.set(remote, pc); }
    conn.on("data", (chunk) => this.onData(pc, chunk));
    conn.on("error", () => this.onDrop(pc, conn));
    conn.on("close", () => this.onDrop(pc, conn));
    const waiters = pc.connectWaiters;
    pc.connectWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private onData(pc: ProviderConn, chunk: Buffer): void {
    pc.buffer += chunk.toString("utf8");
    const parsed = parseLines(pc.buffer);
    pc.buffer = parsed.rest;
    for (const line of parsed.lines) {
      let frame: ForwardFrame;
      try { frame = JSON.parse(line) as ForwardFrame; } catch { continue; }
      const sink = pc.pending.get(frame.id);
      if (!sink) continue;
      if (frame.type === "chunk") {
        sink.onChunk(frame.data);
      } else if (frame.type === "done") {
        pc.pending.delete(frame.id);
        sink.onDone(frame.stats);
      } else {
        pc.pending.delete(frame.id);
        sink.onError(new Error(frame.error || "forward: provider error"));
      }
    }
  }

  private onDrop(pc: ProviderConn, conn: PeerStream): void {
    if (pc.conn !== conn) return;
    this.audit?.record({ event: "note", extra: { role: "forward", phase: "client-conn-dropped", provider: pc.providerKey.slice(0, 16), pending: pc.pending.size } });
    pc.conn = null;
    if (pc.remoteKey) { this.byRemote.delete(pc.remoteKey); pc.remoteKey = null; }
    const sinks = [...pc.pending.values()];
    pc.pending.clear();
    for (const s of sinks) s.onError(new Error("forward: connection dropped"));
  }

  /** Tear down a half-open connection (a request stalled past its frame budget) and leave the topic so
   *  the next forward re-joins → fresh DHT lookup → fresh holepunch, rather than re-binding dead state. */
  private async recycleConn(pc: ProviderConn, stream: PeerStream): Promise<void> {
    if (pc.conn === stream) {
      pc.conn = null;
      if (pc.remoteKey) { this.byRemote.delete(pc.remoteKey); pc.remoteKey = null; }
    }
    const sinks = [...pc.pending.values()];
    pc.pending.clear();
    for (const s of sinks) s.onError(new Error("forward: connection reset"));
    try { stream.destroy(); } catch { /* best effort */ }
    await this.leaveTopic(pc);
  }

  private ensureJoined(pc: ProviderConn): void {
    if (pc.joined) return;
    this.ensureSwarm().join(pc.topic, { server: false, client: true });
    pc.joined = true;
  }

  private async leaveTopic(pc: ProviderConn): Promise<void> {
    if (!pc.joined || !this.swarm) return;
    await this.swarm.leave(pc.topic).catch(() => undefined);
    pc.joined = false;
  }

  private waitForConn(pc: ProviderConn, ms: number): Promise<void> {
    if (pc.conn) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const settle = (): void => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const waiter = { resolve: settle };
      pc.connectWaiters.push(waiter);
      const timer = setTimeout(() => {
        const i = pc.connectWaiters.indexOf(waiter);
        if (i >= 0) pc.connectWaiters.splice(i, 1);
        settle();
      }, ms);
      timer.unref?.();
    });
  }

  /** Establish (or reuse) the warm connection to `providerKey`. Only the first connect gambles on a
   *  cold holepunch — retried up to `attempts` times with a fresh DHT lookup each time. */
  private async ensureConn(providerKey: string, attempts: number): Promise<ProviderConn> {
    if (this.closed) throw new Error("forward client is closed");
    const pc = this.providerConn(providerKey);
    if (pc.conn) return pc;
    if (pc.connecting) {
      await pc.connecting;
      if (!pc.conn) throw new Error("forward: connection unavailable");
      return pc;
    }
    const tries = Math.max(1, attempts);
    pc.connecting = (async () => {
      try {
        for (let attempt = 1; attempt <= tries; attempt++) {
          this.ensureJoined(pc);
          await this.ensureSwarm().flush().catch(() => undefined);
          await this.waitForConn(pc, CONNECT_ATTEMPT_MS);
          if (pc.conn) return;
          this.audit?.record({ event: "note", extra: { role: "forward", phase: "connect-timeout", attempt, provider: providerKey.slice(0, 16) } });
          if (attempt < tries) await this.leaveTopic(pc);
        }
        throw new Error(`forward: could not connect to provider ${providerKey.slice(0, 16)}… after ${tries} attempt(s)`);
      } finally {
        pc.connecting = null;
      }
    })();
    await pc.connecting;
    if (!pc.conn) throw new Error("forward: connection unavailable");
    return pc;
  }

  /**
   * Forward an OpenAI request to `providerKey` and yield its streamed response tokens. Throws on a
   * provider error frame, a dropped connection, or a stalled stream (first-frame / inter-frame budget).
   */
  async *forward(providerKey: string, req: ForwardRequest): AsyncGenerator<string, Record<string, unknown> | undefined> {
    const pc = await this.ensureConn(providerKey, CONNECT_ATTEMPTS);
    const stream = pc.conn;
    if (!stream) throw new Error("forward: connection unavailable");

    const queue: string[] = [];
    let done = false;
    let doneStats: Record<string, unknown> | undefined;
    let failure: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = (): void => { const n = notify; notify = null; n?.(); };
    pc.pending.set(req.id, {
      onChunk: (data) => { queue.push(data); wake(); },
      onDone: (stats) => { done = true; doneStats = stats; wake(); },
      onError: (err) => { failure = err; wake(); },
    });

    const waitNext = (ms: number): Promise<void> => new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; notify = null; reject(new Error(`forward: no frame within ${ms}ms`)); } }, ms);
      timer.unref?.();
      notify = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    });

    let started = false;
    try {
      try {
        stream.write(encodeLine(req));
        this.audit?.record({ event: "note", extra: { role: "forward", phase: "client-sent", provider: providerKey.slice(0, 16), endpoint: req.endpoint } });
      } catch (e) {
        throw new Error(`forward write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (;;) {
        while (queue.length > 0) { started = true; yield queue.shift()!; }
        if (failure) throw failure;
        if (done) return doneStats;
        try {
          await waitNext(started ? IDLE_FRAME_MS : FIRST_FRAME_MS);
        } catch (timeoutErr) {
          await this.recycleConn(pc, stream);
          throw timeoutErr instanceof Error ? timeoutErr : new Error(String(timeoutErr));
        }
      }
    } finally {
      pc.pending.delete(req.id);
    }
  }

  /** Pre-connect to a provider in the background so the cold holepunch is absorbed before a borrow. */
  warm(providerKey: string): void {
    if (this.closed) return;
    void this.ensureConn(providerKey, CONNECT_ATTEMPTS).catch((err) => {
      this.audit?.record({ event: "note", extra: { role: "forward", phase: "warm-failed", provider: providerKey.slice(0, 16), error: err instanceof Error ? err.message : String(err) } });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pc of this.conns.values()) {
      const sinks = [...pc.pending.values()];
      pc.pending.clear();
      for (const s of sinks) s.onError(new Error("forward client closed"));
    }
    if (this.swarm) {
      await this.swarm.destroy().catch(() => undefined);
      this.swarm = null;
    }
  }
}
