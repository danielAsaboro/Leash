import { createHash } from "node:crypto";
import Hyperswarm from "hyperswarm";
import type { AuditLog, SessionSettlementReceipt } from "@mycelium/shared";
import { controlRequestId, type AdvanceAuthorizationRequest, type AdvanceAuthorizationResponse, type ClosePaidSessionRequest, type OpenPaidSessionRequest, type PaidSessionGrant, type PaidSessionQuote, type PaymentControlRequest, type PaymentControlResponse, type QuoteBudgetRequest, type VerifyBudgetRequest, type VerifyBudgetResponse } from "./economy-types.ts";
import type { ProviderEconomyService } from "./provider-economy.ts";

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

const TOPIC_PREFIX = "hypha-paid-session-v1";

// Payment-control transport (consumer → provider). One long-lived per-pair topic carries the whole
// quote → verify → open → close handshake for a provider/consumer pair.
//
// The CLIENT holds ONE persistent Hyperswarm (stable seed → warm DHT/NAT state, no per-request
// churn) and ONE multiplexed connection per provider, reused across every request. The server
// (PaymentControlServer) already keeps each connection open and treats EVERY newline-delimited
// line as an independent request, so the connection multiplexes with no server-side change.
//
// Cold cross-host Hyperswarm discovery costs tens of seconds, so ONLY the first connect gambles on
// a holepunch — retried a few times with a fresh DHT lookup each attempt. Once warm, every later
// request rides the open connection with a short round-trip timeout. `warm()` pre-connects in the
// background the moment a paid provider is discovered, so the cold start is absorbed before the
// user ever triggers a paid completion.
const CONTROL_ATTEMPT_MS = Number(process.env["HYPHA_ECONOMY_CONTROL_ATTEMPT_MS"] ?? 25_000);
const CONTROL_ATTEMPTS = Number(process.env["HYPHA_ECONOMY_CONTROL_ATTEMPTS"] ?? 6);
// Round-trip budget for a request once the connection is warm. A healthy round-trip is sub-second,
// so this is set fail-fast: a long wait here means the held connection is HALF-OPEN (cross-host
// holepunch that bound but never carried data) — we'd rather tear it down and re-holepunch than sit.
const REQUEST_TIMEOUT_MS = Number(process.env["HYPHA_ECONOMY_CONTROL_REQUEST_TIMEOUT_MS"] ?? 15_000);
// How many times the FIRST (idempotent) request of a session re-holepunches when the held connection
// proves half-open. quote validates the connection for the whole session; verify/open/close then ride
// the connection it proved good, so they don't re-gamble (and must not — replay/double-settle).
const QUOTE_REQUEST_ATTEMPTS = Number(process.env["HYPHA_ECONOMY_CONTROL_QUOTE_ATTEMPTS"] ?? 4);
// `close` triggers the on-chain settle, which is slow — give it the longer budget.
const CLOSE_TIMEOUT_MS = Number(process.env["HYPHA_ECONOMY_CONTROL_TIMEOUT_MS"] ?? 120_000);

function topicForPair(providerPublicKey: string, consumerPublicKey: string): Buffer {
  return createHash("sha256").update(`${TOPIC_PREFIX}:${providerPublicKey}:${consumerPublicKey}`).digest();
}

function encodeMessage(message: PaymentControlRequest | PaymentControlResponse): string {
  return JSON.stringify(message) + "\n";
}

function parseLines(buffer: string): { rest: string; lines: string[] } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { rest, lines: parts.filter(Boolean) };
}

export interface PaymentControlServerDeps {
  seed: string;
  audit: AuditLog;
  economy: ProviderEconomyService;
}

export class PaymentControlServer {
  private readonly swarm: Hyperswarm;
  private providerPublicKey: string | null = null;
  private readonly joinedTopics = new Map<string, Buffer>();

  constructor(private readonly deps: PaymentControlServerDeps) {
    // CRITICAL: derive a DISTINCT swarm identity. The raw device seed is already the QVAC SDK
    // worker's hyperdht identity (QVAC_HYPERSWARM_SEED) — two hyperdht servers sharing one keypair
    // make DHT routing for that key flap between sockets, and because both hold the same private
    // key the noise handshake SUCCEEDS against the wrong process: the consumer binds a live
    // connection into the SDK's protomux handler, which silently swallows payment-control JSON
    // (the cross-host half-open-quote bug). Discovery is purely via the per-pair topic announce,
    // so the server's swarm key never needs to equal the gossiped provider key.
    const seed = createHash("sha256").update(`${deps.seed}:payment-control-server`).digest();
    this.swarm = new Hyperswarm({ seed });
    this.swarm.on("connection", (conn, info) => this.handleConnection(conn as PeerStream, info as PeerInfoLike | undefined));
  }

  async ready(): Promise<void> {
    await this.swarm.flush();
  }

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
      this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "server-topic-join", consumer: consumer.slice(0, 16), topic: topic.toString("hex").slice(0, 16) } });
    }
    await this.swarm.flush();
  }

  async close(): Promise<void> {
    await this.swarm.destroy();
  }

  private handleConnection(conn: PeerStream, info?: PeerInfoLike): void {
    const remote = info?.publicKey?.toString("hex").slice(0, 16) ?? "unknown";
    this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "server-conn-open", remote, topics: (info?.topics ?? []).map((t) => t.toString("hex").slice(0, 16)) } });
    let buffer = "";
    conn.on("error", (err) => this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "server-conn-error", remote, error: err instanceof Error ? err.message : String(err) } }));
    conn.on("close", () => this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "server-conn-close", remote } }));
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parsed = parseLines(buffer);
      buffer = parsed.rest;
      for (const line of parsed.lines) {
        this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "server-recv", remote, bytes: line.length } });
        void this.respond(conn, line);
      }
    });
  }

  private async respond(conn: PeerStream, line: string): Promise<void> {
    let request: PaymentControlRequest;
    try {
      request = JSON.parse(line) as PaymentControlRequest;
    } catch {
      conn.write(encodeMessage({ replyTo: "unknown", type: "settlement_receipt", ok: false, error: "bad payment-control JSON" }));
      return;
    }
    const response: PaymentControlResponse = await this.handleRequest(request).catch((err) => ({
      replyTo: request.id,
      type: request.type === "close_paid_session" ? "settlement_receipt" : request.type,
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    conn.write(encodeMessage(response));
    this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "server-reply", type: response.type, ok: response.ok } });
  }

  private async handleRequest(request: PaymentControlRequest): Promise<PaymentControlResponse> {
    switch (request.type) {
      case "quote_budget": {
        const quote = await this.deps.economy.quoteBudget(request.body as QuoteBudgetRequest);
        this.deps.audit.record({ event: "note", extra: { role: "payment-control", phase: "quote_budget", meshId: quote.meshId, alias: quote.alias } });
        return { replyTo: request.id, type: "quote_budget", ok: true, body: quote };
      }
      case "verify_budget": {
        const verified = await this.deps.economy.verifyBudget(request.body as VerifyBudgetRequest);
        return { replyTo: request.id, type: "verify_budget", ok: true, body: verified };
      }
      case "open_paid_session": {
        const grant = await this.deps.economy.openPaidSession(request.body as OpenPaidSessionRequest);
        return { replyTo: request.id, type: "open_paid_session", ok: true, body: grant };
      }
      case "advance_authorization": {
        const ack = await this.deps.economy.advanceAuthorization(request.body as AdvanceAuthorizationRequest);
        return { replyTo: request.id, type: "advance_authorization", ok: true, body: ack };
      }
      case "close_paid_session": {
        const receipt = await this.deps.economy.closePaidSession(request.body as ClosePaidSessionRequest);
        return { replyTo: request.id, type: "settlement_receipt", ok: true, body: receipt };
      }
    }
  }
}

// ── client ─────────────────────────────────────────────────────────────────────────────────────

interface Pending {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
}

/** One persistent, multiplexed connection to a single provider, keyed by its per-pair topic. */
interface ProviderConn {
  providerKey: string;
  topic: Buffer;
  topicHex: string;
  /** The live stream, or null while disconnected (swarm stays joined → Hyperswarm re-establishes). */
  conn: PeerStream | null;
  /** Partial line buffer for newline-framed replies. */
  buffer: string;
  /** In-flight requests by id → resolver, multiplexed over the one connection. */
  pending: Map<string, Pending>;
  /** Callers waiting for the connection to come up. */
  connectWaiters: Array<{ resolve: () => void }>;
  /** The single in-flight connect attempt-chain (shared by concurrent ensureConn/warm callers). */
  connecting: Promise<void> | null;
  joined: boolean;
  /** Remote swarm key (hex) once seen — re-identifies the provider on reconnect. */
  remoteKey: string | null;
}

export class PaymentControlClient {
  private swarm: Hyperswarm | null = null;
  private readonly conns = new Map<string, ProviderConn>(); // providerKey → conn
  private readonly byTopic = new Map<string, string>();      // topicHex → providerKey
  private readonly byRemote = new Map<string, ProviderConn>(); // remote swarm key hex → conn
  private closed = false;

  constructor(
    private readonly consumerPublicKey: () => string | null,
    private readonly seedHex: string,
    private readonly audit?: AuditLog,
  ) {}

  private selfKey(): string {
    const key = this.consumerPublicKey();
    if (!key) throw new Error("consumer public key unavailable");
    return key;
  }

  /**
   * The persistent client swarm, created lazily on first connect/warm. Its identity is derived from
   * this device's seed but DISTINCT from the provider/server swarm identity (which seeds directly
   * off the device seed) — so the client and a co-resident server never collide on the DHT.
   */
  private ensureSwarm(): Hyperswarm {
    if (this.swarm) return this.swarm;
    const seed = createHash("sha256").update(`${this.seedHex}:payment-control-client`).digest();
    const swarm = new Hyperswarm({ seed });
    // Force localConnection:false on every dial from this swarm. hyperdht's same-public-IP "LAN
    // shortcut" (connect.js: ping the server's LAN addr, abort the WHOLE connect if it fails) is
    // broken inside the hypha daemon process — the ping times out and every dial dies with
    // HOLEPUNCH_ABORTED, while the normal punch path connects in <1s (proven live Pro→mini
    // 2026-06-10). hyperswarm exposes no per-connect opts, so wrap the dht.connect of this
    // swarm's OWN dht instance (created per-swarm above — nothing else shares it).
    const dht = (swarm as unknown as { dht: { connect: (key: Buffer, opts?: Record<string, unknown>) => unknown } }).dht;
    const origConnect = dht.connect.bind(dht);
    dht.connect = (key: Buffer, opts?: Record<string, unknown>) => origConnect(key, { ...opts, localConnection: false });
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
      // Unidentifiable, or we already hold a warm connection to this provider (Hyperswarm dedups by
      // remote key, so a duplicate is unexpected) — drop it rather than mis-route replies.
      this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "client-conn-drop", remote, reason: matched ? "duplicate" : "unmatched", topics: (info?.topics ?? []).map((t) => t.toString("hex").slice(0, 16)) } });
      try { conn.destroy(); } catch { /* best effort */ }
      return;
    }
    this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "client-conn-bind", remote, via: matched.via, provider: matched.pc.providerKey.slice(0, 16) } });
    this.bind(matched.pc, conn, info);
  }

  /** Route an incoming connection to the provider it belongs to. */
  private matchConn(info: PeerInfoLike | undefined): { pc: ProviderConn; via: string } | null {
    // 1) by the topic we looked the provider up on (the normal path).
    for (const t of info?.topics ?? []) {
      const provider = this.byTopic.get(t.toString("hex"));
      const pc = provider ? this.conns.get(provider) : undefined;
      if (pc) return { pc, via: "topic" };
    }
    // 2) by a remote swarm key recorded on a prior connection (robust across reconnects).
    const remote = info?.publicKey?.toString("hex");
    if (remote) {
      const pc = this.byRemote.get(remote);
      if (pc) return { pc, via: "remote-key" };
    }
    // 3) single-pending fallback: exactly one provider awaiting its first connection.
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
      let reply: PaymentControlResponse;
      try { reply = JSON.parse(line) as PaymentControlResponse; } catch { continue; }
      const waiter = pc.pending.get(reply.replyTo);
      if (!waiter) continue;
      pc.pending.delete(reply.replyTo);
      if (reply.ok) waiter.resolve(reply.body);
      else waiter.reject(new Error(reply.error || `payment-control ${reply.type} failed`));
    }
  }

  private onDrop(pc: ProviderConn, conn: PeerStream): void {
    if (pc.conn !== conn) return; // dedup error+close + ignore handlers from a superseded stream
    this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "client-conn-dropped", provider: pc.providerKey.slice(0, 16), pending: pc.pending.size } });
    pc.conn = null;
    if (pc.remoteKey) { this.byRemote.delete(pc.remoteKey); pc.remoteKey = null; }
    const pending = [...pc.pending.values()];
    pc.pending.clear();
    for (const p of pending) p.reject(new Error("payment-control connection dropped"));
    // The swarm stays joined → Hyperswarm re-establishes; the next request reconnects on demand.
  }

  /**
   * Tear down a connection that proved HALF-OPEN (a request round-tripped to a timeout). Hyperswarm
   * fires the `connection` event once the secret-stream handshake completes, but a cross-host
   * holepunch can bind a stream that never actually carries data — and since no close/error ever
   * fires, the dead stream would be held and reused forever. So we destroy it AND leave the topic,
   * so the next ensureConn re-joins → fresh DHT lookup → fresh holepunch (a new gamble, like the old
   * per-request swarm did) rather than silently re-binding the same broken peer state.
   */
  private async recycleConn(pc: ProviderConn, stream: PeerStream): Promise<void> {
    if (pc.conn === stream) {
      pc.conn = null;
      if (pc.remoteKey) { this.byRemote.delete(pc.remoteKey); pc.remoteKey = null; }
    }
    const pending = [...pc.pending.values()];
    pc.pending.clear();
    for (const p of pending) p.reject(new Error("payment-control connection reset"));
    try { stream.destroy(); } catch { /* best effort */ }
    await this.leaveTopic(pc); // drop the topic so the rejoin is a fresh lookup, not an auto-reconnect to the same broken state
  }

  /** Hyperswarm-internals snapshot for diagnosing silent connect failures (best-effort). */
  private debugState(pc: ProviderConn): Record<string, unknown> {
    try {
      const swarm = this.swarm as unknown as {
        connections?: Set<unknown>;
        peers?: Map<string, { publicKey?: Buffer; attempts?: number; banned?: boolean; client?: boolean; server?: boolean; topics?: Buffer[] }>;
        connecting?: number;
        _discovery?: Map<string, { isClient?: boolean; isServer?: boolean; destroyed?: boolean }>;
        dht?: { bootstrapped?: boolean; firewalled?: boolean; port?: number; host?: string };
      } | null;
      if (!swarm) return { swarm: null };
      const peers = [...(swarm.peers?.values() ?? [])].map((p) => ({
        pk: p.publicKey?.toString("hex").slice(0, 16),
        attempts: p.attempts,
        banned: p.banned,
        topics: (p.topics ?? []).map((t) => t.toString("hex").slice(0, 8)),
      }));
      const disc = swarm._discovery?.get(pc.topicHex);
      return {
        conns: swarm.connections?.size,
        connecting: swarm.connecting,
        peers,
        discovery: disc ? { isClient: disc.isClient, isServer: disc.isServer, destroyed: disc.destroyed } : "none",
        dht: { bootstrapped: swarm.dht?.bootstrapped, firewalled: swarm.dht?.firewalled, port: swarm.dht?.port, host: swarm.dht?.host },
      };
    } catch (e) {
      return { debugError: String(e) };
    }
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

  /** Resolve when the connection is up, or after `ms` (caller re-checks `pc.conn`). */
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

  /**
   * Establish (or reuse) the warm connection to `providerKey`. Only the first connect gambles on a
   * cold holepunch — retried up to `attempts` times with a fresh DHT lookup each time. Concurrent
   * callers (a real request + the background warm-up) share the single in-flight attempt-chain.
   */
  private async ensureConn(providerKey: string, attempts: number): Promise<ProviderConn> {
    if (this.closed) throw new Error("payment-control client is closed");
    const pc = this.providerConn(providerKey);
    if (pc.conn) return pc;
    if (pc.connecting) {
      await pc.connecting;
      if (!pc.conn) throw new Error("payment-control: connection unavailable");
      return pc;
    }
    const tries = Math.max(1, attempts);
    pc.connecting = (async () => {
      try {
        for (let attempt = 1; attempt <= tries; attempt++) {
          this.ensureJoined(pc);
          await this.ensureSwarm().flush().catch(() => undefined);
          await this.waitForConn(pc, CONTROL_ATTEMPT_MS);
          if (pc.conn) return;
          this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "connect-timeout", attempt, provider: providerKey.slice(0, 16), state: this.debugState(pc) } });
          if (attempt < tries) {
            await this.leaveTopic(pc); // fresh holepunch gamble on the next attempt
          }
        }
        throw new Error(`payment-control: could not connect to provider ${providerKey.slice(0, 16)}… after ${tries} attempt(s)`);
      } finally {
        pc.connecting = null;
      }
    })();
    await pc.connecting;
    if (!pc.conn) throw new Error("payment-control: connection unavailable");
    return pc;
  }

  private async send<T>(
    providerKey: string,
    type: PaymentControlRequest["type"],
    body: unknown,
    opts: { connectAttempts: number; timeoutMs: number; requestAttempts: number },
  ): Promise<T> {
    let lastErr: Error | undefined;
    const requestAttempts = Math.max(1, opts.requestAttempts);
    for (let tryNo = 1; tryNo <= requestAttempts; tryNo++) {
      const pc = await this.ensureConn(providerKey, opts.connectAttempts);
      const stream = pc.conn;
      if (!stream) throw new Error("payment-control: connection unavailable");
      const id = controlRequestId();
      try {
        return await new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            pc.pending.delete(id);
            reject(new Error(`payment-control ${type} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs);
          timer.unref?.();
          pc.pending.set(id, {
            resolve: (b) => { clearTimeout(timer); resolve(b as T); },
            reject: (e) => { clearTimeout(timer); reject(e); },
          });
          try {
            stream.write(encodeMessage({ id, type, body } as PaymentControlRequest));
            this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "client-sent", type, provider: providerKey.slice(0, 16), tryNo } });
          } catch (e) {
            clearTimeout(timer);
            pc.pending.delete(id);
            reject(new Error(`payment-control ${type} write failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const msg = lastErr.message;
        const timedOut = msg.includes("timed out");
        const dropped = msg.includes("connection dropped") || msg.includes("connection reset") || msg.includes("write failed");
        // A round-trip timeout means the held connection is half-open — recycle it so the next try
        // re-holepunches a fresh connection. (A genuine protocol error from the provider arrives as a
        // fast `ok:false` reply, never a timeout, so it is NOT recycled/retried.)
        if (timedOut) await this.recycleConn(pc, stream);
        // Only the idempotent FIRST request (quote) re-tries across fresh holepunches; verify/open
        // consume the authorization (replay-rejected on resend) and close could double-settle.
        if ((timedOut || dropped) && tryNo < requestAttempts) continue;
        throw lastErr;
      }
    }
    throw lastErr ?? new Error(`payment-control ${type}: failed`);
  }

  /**
   * Pre-connect to a paid provider in the background so the cold holepunch is absorbed before the
   * user triggers a paid completion. Idempotent + fire-and-forget (a no-op once warm/connecting).
   */
  warm(providerKey: string): void {
    if (this.closed) return;
    void this.ensureConn(providerKey, CONTROL_ATTEMPTS).catch((err) => {
      this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "warm-failed", provider: providerKey.slice(0, 16), error: err instanceof Error ? err.message : String(err) } });
    });
  }

  async quoteBudget(providerPublicKey: string, body: QuoteBudgetRequest): Promise<PaidSessionQuote> {
    // quote is the session's first request: it re-holepunches across a few fresh connections until
    // one round-trips, validating the connection that verify/open/close then ride.
    const quote = await this.send<PaidSessionQuote>(providerPublicKey, "quote_budget", body, { connectAttempts: CONTROL_ATTEMPTS, timeoutMs: REQUEST_TIMEOUT_MS, requestAttempts: QUOTE_REQUEST_ATTEMPTS });
    this.audit?.record({ event: "note", extra: { role: "payment-control", phase: "quote_budget", meshId: quote.meshId, alias: quote.alias } });
    return quote;
  }

  async verifyBudget(providerPublicKey: string, body: VerifyBudgetRequest): Promise<VerifyBudgetResponse> {
    return this.send<VerifyBudgetResponse>(providerPublicKey, "verify_budget", body, { connectAttempts: CONTROL_ATTEMPTS, timeoutMs: REQUEST_TIMEOUT_MS, requestAttempts: 1 });
  }

  async openPaidSession(providerPublicKey: string, body: OpenPaidSessionRequest): Promise<PaidSessionGrant> {
    return this.send<PaidSessionGrant>(providerPublicKey, "open_paid_session", body, { connectAttempts: CONTROL_ATTEMPTS, timeoutMs: REQUEST_TIMEOUT_MS, requestAttempts: 1 });
  }

  async advanceAuthorization(providerPublicKey: string, body: AdvanceAuthorizationRequest): Promise<AdvanceAuthorizationResponse> {
    // Rides the warm connection from quote/open. Idempotent on (sessionId, tierIndex), so a transport
    // retry is safe — but keep it single-shot here; the consumer loop re-advances if a rung is lost.
    return this.send<AdvanceAuthorizationResponse>(providerPublicKey, "advance_authorization", body, { connectAttempts: 1, timeoutMs: REQUEST_TIMEOUT_MS, requestAttempts: 1 });
  }

  async closePaidSession(providerPublicKey: string, body: ClosePaidSessionRequest): Promise<SessionSettlementReceipt> {
    // NEVER retry the settle — a duplicate close could double-charge the payer. A single connect
    // gamble; in the usual case the connection is already warm from quote/verify/open and is reused.
    return this.send<SessionSettlementReceipt>(providerPublicKey, "close_paid_session", body, { connectAttempts: 1, timeoutMs: CLOSE_TIMEOUT_MS, requestAttempts: 1 });
  }

  /** Tear down the persistent swarm + fail any in-flight requests. Mirrors PaymentControlServer.close(). */
  async close(): Promise<void> {
    this.closed = true;
    for (const pc of this.conns.values()) {
      const pending = [...pc.pending.values()];
      pc.pending.clear();
      for (const p of pending) p.reject(new Error("payment-control client closed"));
    }
    if (this.swarm) {
      await this.swarm.destroy().catch(() => undefined);
      this.swarm = null;
    }
  }
}
