/**
 * MeshGraph (Layer 1 — Mesh): the replicated context-graph store.
 *
 * Corestore + multi-writer Autobase + a Hyperbee view keyed by node.id (a grow-only
 * G-Set CRDT: append-only, idempotent dedupe) + its own Hyperswarm. Drop-in for the
 * Week-1 JSONL GraphStore (append/all) plus lifecycle + dynamic blind-pairing.
 *
 * Autobase carries ONLY graph nodes — never model traffic (hard constraint). The
 * apply() function is the entire CRDT: two idempotent entry shapes.
 *
 * Proven by spike/05-autobase-pairing.ts (gate PASSED): bidirectional multi-writer
 * sync, blind-pairing→add-writer, id-dedupe, and coexistence with the SDK's swarm.
 * Notes the spike settled: a plain Hyperbee `put` is durable (no view.flush); a
 * paired store recovers its base on reopen via the local core's `referrer` userData
 * (so `open()` with no bootstrapKey rejoins the same mesh); `update()` is arg-less
 * and never blocks on peers (R6).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Corestore, { type Hypercore } from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import Hyperswarm from "hyperswarm";
import BlindPairing from "blind-pairing";
import b4a from "b4a";
import type { GraphNode, GraphNodeInput, AuditLog, DeviceCapability, SessionSettlementReceipt } from "@mycelium/shared";

/**
 * A task replicated across the private mesh. Superset of the desktop `LeashTask`
 * (packages/leash-core) and the mobile `Task` (apps/mobile/tasks.ts); both map onto it.
 * LWW by `updatedAt`; a delete is a tombstone (`deleted: true`) so it converges too.
 */
export interface MeshTask {
  id: string;
  title: string;
  detail?: string;
  status: "open" | "in_progress" | "done" | "dropped";
  priority: "low" | "normal" | "high";
  tags: string[];
  source: string; // "user" | "assistant" | device origin
  createdAt: number;
  updatedAt: number; // LWW key (epoch ms)
  deleted?: boolean; // tombstone
}

type Entry =
  | { type: "node"; node: GraphNode }
  | { type: "add-writer"; key: string }
  | { type: "remove-writer"; key: string }
  | { type: "capability"; cap: DeviceCapability }
  | { type: "forget-capability"; deviceId: string }
  | { type: "unpair"; a: string; b: string; active: boolean; ts: string }
  | { type: "receipt"; receipt: SessionSettlementReceipt }
  | { type: "adapter"; meta: AdapterMeta }
  | { type: "plugin"; meta: MeshPluginMeta }
  | { type: "task"; task: MeshTask }
  | { type: "task-delete"; id: string; ts: number };

/**
 * The TINY pointer a published LoRA adapter rides on the CRDT. The adapter BYTES live
 * on a sibling Hypercore (`adapter-feed`) the corestore replicates — never on the
 * Autobase (hard constraint, line 8). This meta is all that touches the graph: it says
 * which core (`feedKey`) and which block range (`startBlock`..`+blockCount`) hold the
 * adapter, plus the checksum to verify the reassembled bytes against.
 */
export interface AdapterMeta {
  version: string;
  baseModel: string;
  evalDelta: number;
  sha256: string;
  sizeBytes: number;
  /** Hex key of the sibling Hypercore holding the bytes. */
  feedKey: string;
  /** First block index of this adapter on the feed (that block = the manifest JSON). */
  startBlock: number;
  /** Total blocks for this adapter (1 manifest + N gguf chunks). */
  blockCount: number;
  /** gguf chunk size in bytes (manifest block excluded). */
  chunkSize: number;
  publishedAt: string;
}

/**
 * The TINY pointer a published plugin bundle rides on the CRDT — the plugin analogue of
 * {@link AdapterMeta}. The zip BYTES live on a sibling Hypercore (`plugin-feed`); only this
 * meta touches the graph. UNLIKE adapters (single `adapter:latest` winner), plugins form a
 * per-id catalog: the reducer keys each by `plugin:<pluginId>`, so many coexist. The first
 * six fields mirror the web's `MeshPluginMeta` contract (apps/web/lib/leash/plugin-sources/mesh.ts);
 * the trailing blob coords are how `fetchPlugin` finds + verifies the bytes.
 */
export interface MeshPluginMeta {
  pluginId: string;
  name: string;
  version?: string;
  description?: string;
  sha256: string;
  /** Zip size in bytes (the `size` field the web catalog expects). */
  size: number;
  /** Hex key of the sibling Hypercore holding the bytes. */
  feedKey: string;
  /** First block index of this plugin on the feed (that block = the manifest JSON). */
  startBlock: number;
  /** Total blocks for this plugin (1 manifest + N zip chunks). */
  blockCount: number;
  /** Zip chunk size in bytes (manifest block excluded). */
  chunkSize: number;
  publishedAt: string;
}

/** gguf chunk size on the adapter feed (256 KiB — well under Hypercore's block cap). */
const ADAPTER_CHUNK = 256 * 1024;

/** zip chunk size on the plugin feed (256 KiB — same cap discipline as the adapter feed). */
const PLUGIN_CHUNK = 256 * 1024;

/** Verify reassembled bytes against a pointer's checksum + size. Throws on mismatch. Generic over
 *  both AdapterMeta (`sizeBytes`) and MeshPluginMeta (`size`) — pass whichever size field you hold. */
export function verifyBytes(bytes: Buffer, expect: { sha256: string; size: number }, label = "blob"): void {
  if (bytes.length !== expect.size) {
    throw new Error(`${label} size mismatch: ${bytes.length} != ${expect.size} bytes (truncated / corrupt)`);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== expect.sha256) {
    throw new Error(`${label} sha256 mismatch: ${sha.slice(0, 12)}… != ${expect.sha256.slice(0, 12)}… (corrupt or tampered block)`);
  }
}

/** Verify reassembled adapter bytes against the pointer's checksum + size. Throws on mismatch. */
export function verifyAdapterBytes(bytes: Buffer, meta: Pick<AdapterMeta, "sha256" | "sizeBytes">): void {
  verifyBytes(bytes, { sha256: meta.sha256, size: meta.sizeBytes }, "adapter");
}

/** Bounded read of a block range from a (possibly remote) core — R6: never an unbounded wait. */
async function fetchRange(core: Hypercore, start: number, count: number, timeoutMs: number): Promise<Buffer[]> {
  try {
    core.download({ start, end: start + count }); // best-effort prefetch; don't depend on its return shape
  } catch {
    /* some builds lack download() — fall back to per-block waits below */
  }
  const deadline = Date.now() + timeoutMs;
  const out: Buffer[] = [];
  for (let i = start; i < start + count; i++) {
    let blk = await core.get(i, { wait: false });
    while (blk == null && Date.now() < deadline) {
      await sleep(150);
      blk = await core.get(i, { wait: false });
    }
    if (blk == null) throw new Error(`adapter block ${i} not replicated within ${timeoutMs}ms (offline / peer absent)`);
    out.push(blk);
  }
  return out;
}

/** One replicated unpair edge between two devices (writer keys). active=true → unpaired. */
export interface UnpairRecord {
  a: string;
  b: string;
  active: boolean;
  ts: string;
}

/** Canonical view key for an unpair edge — order-independent across the two writer keys. */
export const unpairKey = (a: string, b: string): string => "unpair:" + [a, b].sort().join("|");

export interface MeshGraphOptions {
  /** Directory for the corestore (one per device/role). Omit when `store` is injected. */
  storeDir?: string;
  /**
   * Injected Corestore (or a `rootStore.namespace(meshId)`). When set, MeshGraph does NOT
   * create its own store from `storeDir` and does NOT close it on `close()` — the owner (a
   * MeshHost holding several meshes on one root store + one swarm) does. See spec §3.
   */
  store?: Corestore;
  /**
   * Injected shared Hyperswarm owned by a MeshHost. When set, `joinSwarm()` only JOINS this
   * mesh's discovery key on it (the host registers the single `rootStore.replicate(conn)`
   * handler and owns the swarm's lifecycle); `close()` leaves the topic but never destroys it.
   */
  sharedSwarm?: Hyperswarm;
  /**
   * Existing autobase key to boot against. Usually omitted: a fresh store founds a
   * new mesh (the hub); a previously-paired store recovers its base automatically
   * via the local core's `referrer` (the edge on reopen).
   */
  bootstrapKey?: Buffer | null;
  /**
   * Optional 64-hex seed → deterministic corestore primary key → stable autobase
   * key across fresh stores (CI/repeatable demos), mirroring QVAC_HYPERSWARM_SEED.
   * Omit in normal use: a persistent store already gives a stable key across restarts.
   */
  seed?: string;
  /** Whether to stand up our own Hyperswarm (false for local-only tests). */
  swarm?: boolean;
  /**
   * If set and non-empty, only these device writer-keys (hex `localWriterKey`) may
   * pair and become writers. A leaked invite alone no longer adds a writer. Empty or
   * absent = open (back-compat with the existing demos).
   */
  allowedDevices?: Set<string>;
  audit?: AuditLog;
}

export interface PairOptions {
  /** Directory for the corestore. Omit when `store` is injected. */
  storeDir?: string;
  /** Injected Corestore / namespace (a MeshHost membership). See {@link MeshGraphOptions.store}. */
  store?: Corestore;
  /** Injected shared Hyperswarm (a MeshHost). See {@link MeshGraphOptions.sharedSwarm}. */
  sharedSwarm?: Hyperswarm;
  /** Hex blind-pairing invite minted by the host's mintInvite(). */
  invite: string;
  /** Give up (close the half-open swarm/store and throw) if the host hasn't confirmed by then. */
  timeoutMs?: number;
  audit?: AuditLog;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build our Corestore with `allowBackup: true` — this DISABLES the per-store
 * rocksdb device-file lock. That lock is a volume-level safety marker; when our
 * store and the SDK's `~/.qvac` corestores (rag-hyperdb / registry) live on the
 * SAME physical volume (e.g. the repo + ~/.qvac both symlinked to one external
 * SSD), the two stores collide on it and the SDK worker throws "Invalid device
 * file, was modified" on its next corestore open. We never open the same mesh-store
 * from two processes (each device owns its own), so skipping the lock is safe.
 * Discovered via spike-style bisection (Task 6); see the Week-2 Sawdust entry.
 */
function makeStore(storeDir: string, seed?: string): Corestore {
  const opts: { primaryKey?: Buffer; allowBackup: boolean; unsafe?: boolean } = { allowBackup: true };
  // A deterministic seed → fixed corestore primary key → stable autobase/device key
  // (CI/repeatable demos, registry keys, allow-list entries). Corestore now guards
  // primaryKey behind `unsafe: true`; we intentionally opt in — the seed is supplied
  // explicitly by the operator, never derived from untrusted input.
  if (seed) { opts.primaryKey = b4a.from(seed, "hex"); opts.unsafe = true; }
  return new Corestore(storeDir, opts);
}

/** The autobase view: a Hyperbee keyed by node.id (idempotent grow-only set). */
function viewOpen(store: unknown) {
  return new Hyperbee((store as Corestore).get("view"), { keyEncoding: "utf-8", valueEncoding: "json" });
}
/** The entire CRDT: idempotent entry shapes. (No view.flush — plain Hyperbee put is durable.) */
async function viewApply(nodes: Array<{ value: Entry }>, view: unknown, host: { addWriter(key: Buffer, opts?: { indexer?: boolean }): Promise<void>; removeWriter?(key: Buffer): Promise<void> }) {
  const bee = view as Hyperbee;
  for (const { value } of nodes) {
    if (value?.type === "add-writer") { await host.addWriter(b4a.from(value.key, "hex"), { indexer: true }); continue; }
    if (value?.type === "remove-writer") {
      // Revoke a device's write access (disconnect/unpair). Guarded: not every Autobase build
      // supports removeWriter — a failure must not break linearization of the rest of the batch.
      try { await host.removeWriter?.(b4a.from(value.key, "hex")); } catch { /* unsupported / already gone */ }
      continue;
    }
    if (value?.type === "node") { await bee.put("node:" + value.node.id, value.node); continue; }
    if (value?.type === "capability") { await bee.put("cap:" + value.cap.deviceId, value.cap); continue; }
    if (value?.type === "forget-capability") { await bee.del("cap:" + value.deviceId); continue; }
    if (value?.type === "unpair") {
      // LWW per pair-edge by ts: a later re-pair retraction (active:false) must beat an earlier
      // unpair. `>=` so a same-ts record from the later log position wins (retraction-friendly).
      const key = unpairKey(value.a, value.b);
      const existing = (await bee.get(key)) as { value?: UnpairRecord } | null;
      if (!existing?.value || value.ts >= existing.value.ts) {
        await bee.put(key, { a: value.a, b: value.b, active: value.active, ts: value.ts } satisfies UnpairRecord);
      }
      continue;
    }
    if (value?.type === "receipt") {
      await bee.put("receipt:" + value.receipt.sessionId, value.receipt);
      continue;
    }
    if (value?.type === "adapter") {
      // Adapter pointer: keep every version (`adapter:<version>`) and track the newest
      // (`adapter:latest`). LWW by version stamp — versions are lexicographically
      // chronological, so `>=` keeps the latest (and a re-publish of the same version wins).
      const meta = value.meta;
      await bee.put("adapter:" + meta.version, meta);
      const cur = (await bee.get("adapter:latest")) as { value?: AdapterMeta } | null;
      if (!cur?.value || meta.version >= cur.value.version) await bee.put("adapter:latest", meta);
    }
    if (value?.type === "plugin") {
      // Plugin catalog: keyed PER ID (`plugin:<pluginId>`) so every published plugin coexists
      // (unlike adapters, which keep a single `adapter:latest` winner). A re-publish of the same
      // id overwrites its row (latest bytes win) — last-writer by linearization order.
      await bee.put("plugin:" + value.meta.pluginId, value.meta);
    }
  }
}

export class MeshGraph {
  private store: Corestore;
  private base: Autobase<Entry>;
  private swarm: Hyperswarm | null = null;
  private pairing: BlindPairing | null = null;
  private member: { flushed(): Promise<void>; close(): Promise<void> } | null = null;
  private allowedDevices?: Set<string>;
  private readonly audit?: AuditLog;
  /** False when store/swarm were injected by a MeshHost — `close()` must not dispose them. */
  private ownsStore = true;
  private ownsSwarm = true;
  /** The injected shared swarm, if any (joined topic-only; the host owns replication + destroy). */
  private externalSwarm: Hyperswarm | null = null;

  private constructor(store: Corestore, base: Autobase<Entry>, audit?: AuditLog) {
    this.store = store;
    this.base = base;
    this.audit = audit;
  }

  private static build(store: Corestore, bootstrapKey: Buffer | null, audit?: AuditLog): MeshGraph {
    const base = new Autobase<Entry>(store, bootstrapKey, { valueEncoding: "json", open: viewOpen, apply: viewApply });
    return new MeshGraph(store, base, audit);
  }

  /**
   * Open (and ready) a MeshGraph. A fresh store founds a new mesh; a previously-
   * paired store recovers its writable base (do NOT call this on a fresh edge store
   * expecting to join the hub — use pair() the first time).
   */
  static async open(opts: MeshGraphOptions): Promise<MeshGraph> {
    if (!opts.store && !opts.storeDir) throw new Error("MeshGraph.open needs `storeDir` or an injected `store`");
    const store = opts.store ?? makeStore(opts.storeDir as string, opts.seed);
    const g = MeshGraph.build(store, opts.bootstrapKey ?? null, opts.audit);
    g.allowedDevices = opts.allowedDevices;
    g.ownsStore = !opts.store;
    if (opts.sharedSwarm) { g.externalSwarm = opts.sharedSwarm; g.ownsSwarm = false; }
    try {
      await g.base.ready();
    } catch (err) {
      // A failed open must not keep holding the rocksdb lock in-process (every later open
      // of this dir would die with "lock hold by current process") — close before rethrowing.
      // Only when WE own the store; an injected store is the MeshHost's to dispose.
      if (g.ownsStore) await store.close().catch(() => undefined);
      throw err;
    }
    return g;
  }

  async ready(): Promise<void> { await this.base.ready(); }
  get autobaseKey(): string { return b4a.toString(this.base.key, "hex"); }
  get localWriterKey(): string { return b4a.toString(this.base.local.key, "hex"); }
  get writable(): boolean { return this.base.writable; }
  /** Live swarm connection count (0 if not swarming) — replication liveness. */
  get peerCount(): number { return this.swarm ? this.swarm.connections.size : 0; }
  /** Number of writers Autobase has linearized (host + any added writers). */
  writerCount(): number {
    const aw = (this.base as unknown as { activeWriters?: { size: number } }).activeWriters;
    return aw?.size ?? (this.base.writable ? 1 : 0);
  }

  /**
   * This device is the ONLY writer — a lone/un-joined mesh (founded but never joined by a
   * peer). Safe to abandon (close + delete) so the device can join another mesh instead.
   * A mesh with ≥2 writers holds real peers and must not be silently discarded.
   */
  isLone(): boolean {
    return this.writerCount() <= 1;
  }

  /**
   * Add a device writer-key to the pairing allow-list at runtime (LAN click-to-pair). The
   * host calls this for the initiator's key BEFORE handing back an invite, so a sniffed
   * invite is useless to any other key (the allow-list is the real capability gate).
   */
  allow(writerKey: string): void {
    if (!this.allowedDevices) this.allowedDevices = new Set<string>();
    this.allowedDevices.add(writerKey);
  }

  /** Remove a device writer-key from the pairing allow-list (revoke its ability to re-pair). */
  disallow(writerKey: string): void {
    this.allowedDevices?.delete(writerKey);
  }

  /**
   * Forget a peer's advertised capability (delete `cap:<deviceId>` from the view). A LIVE
   * peer re-advertises within a heartbeat and reappears (correct); a stale/dead one stays
   * gone. Pairs with the firewall reconcile (cap gone → peer dropped from the serve allow-list)
   * and the warm pool (cap gone → its warm models are dropped).
   */
  async forgetCapability(deviceId: string): Promise<void> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot forget a capability");
    await this.base.append({ type: "forget-capability", deviceId });
    this.audit?.record({ event: "capability", extra: { deviceId, role: "forget" } });
  }

  /**
   * Record (active=true) or retract (active=false) a mutual unpair between two devices.
   * The record replicates like any other entry, so the OTHER device's daemon learns to
   * tombstone the initiator back (or to clear the tombstone on re-pair). LWW by ts in apply.
   */
  async unpair(a: string, b: string, active: boolean): Promise<void> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot record an unpair");
    await this.base.append({ type: "unpair", a, b, active, ts: new Date().toISOString() });
    this.audit?.record({ event: "pairing", extra: { role: "unpair", a, b, active } });
  }

  /** Read every pair-edge's latest unpair record from the replicated view. */
  async unpairs(): Promise<UnpairRecord[]> {
    await this.base.update();
    const out: UnpairRecord[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "unpair:", lt: "unpair;" })) out.push(value as UnpairRecord);
    return out;
  }

  /** Revoke a device's write access to the mesh (full disconnect/unpair). Best-effort. */
  async removeWriter(writerKey: string): Promise<void> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot remove a writer");
    await this.base.append({ type: "remove-writer", key: writerKey });
    this.audit?.record({ event: "pairing", extra: { role: "host", phase: "remove-writer", writerKey } });
  }

  /**
   * Re-grant a device's write access — the inverse of `removeWriter`, so "Restore" can
   * reverse "Disconnect" mesh-wide (a `forget` `removeWriter`s the peer; without this the
   * peer stays `writable:false` forever after a restore). Appends the SAME `add-writer`
   * record the pairing `onadd` flow uses, so the promoted writer replicates to the peer.
   * Idempotent (re-adding a current writer is a no-op in autobase). Best-effort.
   */
  async addWriter(writerKey: string): Promise<void> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot add a writer");
    await this.base.append({ type: "add-writer", key: writerKey });
    this.audit?.record({ event: "pairing", extra: { role: "host", phase: "re-add-writer", writerKey } });
  }

  /**
   * The writer-key a (possibly fresh) store at `storeDir` would use, computed WITHOUT
   * pairing — corestore persists its primary key on first `ready()`, so reopening the same
   * dir later via `pair()` yields the SAME key. Lets a joiner hand its key to the host up
   * front (so the host can allow-list it before the joiner redeems the invite).
   */
  static async prospectiveWriterKey(storeDir: string, seed?: string): Promise<string> {
    const store = makeStore(storeDir, seed);
    await store.ready();
    const localCore = Autobase.getLocalCore(store);
    await localCore.ready();
    const key = b4a.toString(localCore.key, "hex");
    await localCore.close();
    await store.close();
    return key;
  }

  /** Append a node to THIS device's input. Fills id/ts like GraphStore.append. */
  async append(input: GraphNodeInput): Promise<GraphNode> {
    const node: GraphNode = {
      id: input.id ?? randomUUID(),
      ts: input.ts ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      text: input.text,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    await this.base.append({ type: "node", node });
    this.audit?.record({ event: "graph_sync", extra: { added: 1, direction: "local", id: node.id } });
    return node;
  }

  /** Read the local view in id order. update() never blocks on peers (R6). */
  async all(): Promise<GraphNode[]> {
    await this.base.update();
    const out: GraphNode[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "node:", lt: "node;" })) out.push(value as GraphNode);
    return out;
  }

  /** Linearize whatever has locally replicated. Never blocks on peers. */
  async update(): Promise<void> { await this.base.update(); }

  /** Advertise THIS device's capability to the mesh (LWW per deviceId). */
  async advertise(cap: DeviceCapability): Promise<void> {
    await this.base.append({ type: "capability", cap });
    this.audit?.record({ event: "capability", extra: { deviceId: cap.deviceId, isProvider: cap.isProvider, role: "advertise" } });
  }

  /** Read every device's latest advertised capability from the replicated view. */
  async capabilities(): Promise<DeviceCapability[]> {
    await this.base.update();
    const out: DeviceCapability[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "cap:", lt: "cap;" })) out.push(value as DeviceCapability);
    return out;
  }

  /** Advertise one signed paid-session receipt into the mesh-visible replicated state. */
  async publishReceipt(receipt: SessionSettlementReceipt): Promise<void> {
    await this.base.append({ type: "receipt", receipt });
    this.audit?.record({ event: "note", extra: { role: "receipt", meshId: receipt.meshId, sessionId: receipt.sessionId, status: receipt.status } });
  }

  /** Read the replicated paid-session receipts currently visible in this mesh. */
  async receipts(): Promise<SessionSettlementReceipt[]> {
    await this.base.update();
    const out: SessionSettlementReceipt[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "receipt:", lt: "receipt;" })) out.push(value as SessionSettlementReceipt);
    return out;
  }

  /**
   * Bounded best-effort replication wait: poll until the node count is stable for
   * `settleMs`, or `timeoutMs` elapses. Returns fast offline (no peer → count is
   * stable immediately, returns after settleMs). Use before a query that needs the
   * latest synced nodes (R6: never an unbounded wait).
   */
  async sync(opts: { timeoutMs?: number; settleMs?: number } = {}): Promise<number> {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const settleMs = opts.settleMs ?? 1000;
    const t0 = Date.now();
    let last = (await this.all()).length;
    let stableSince = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(250);
      const n = (await this.all()).length;
      if (n !== last) { last = n; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= settleMs) break;
    }
    return last;
  }

  /** Fire cb(all()) after each apply — drives incremental embedding. */
  onChange(cb: (nodes: GraphNode[]) => void | Promise<void>): void {
    this.base.on("update", () => { void Promise.resolve(this.all()).then(cb); });
  }

  /** Stand up our own Hyperswarm (separate from the SDK's), join the autobase topic. No-op if already swarming. */
  async joinSwarm(): Promise<void> {
    if (this.swarm) return;
    // Injected shared swarm (MeshHost): JOIN this mesh's topic only — the host registers the
    // single `rootStore.replicate(conn)` handler (covering every namespace) and owns the swarm.
    if (this.externalSwarm) {
      this.swarm = this.externalSwarm;
      this.swarm.join(this.base.discoveryKey);
      await this.swarm.flush();
      return;
    }
    this.swarm = new Hyperswarm();
    this.swarm.on("connection", (conn) => { this.store.replicate(conn); });
    this.swarm.join(this.base.discoveryKey);
    await this.swarm.flush();
  }

  /** Host: mint a hex invite and auto-confirm the first candidate as a writer. */
  async mintInvite(): Promise<string> {
    if (!this.swarm) throw new Error("call joinSwarm() before mintInvite()");
    // Re-minting (PIN retries / a second pairing session) must not leak the previous
    // member + BlindPairing — close them first; only the latest invite stays redeemable.
    if (this.member) {
      await this.member.close().catch(() => undefined);
      this.member = null;
    }
    if (this.pairing) {
      await this.pairing.close().catch(() => undefined);
      this.pairing = null;
    }
    const { invite, publicKey } = BlindPairing.createInvite(this.base.key);
    this.pairing = new BlindPairing(this.swarm);
    this.member = this.pairing.addMember({
      discoveryKey: this.base.discoveryKey,
      onadd: async (req) => {
        try {
          req.open(publicKey); // decrypt-only: populates req.userData, grants nothing
          const writerKey = b4a.toString(req.userData, "hex");
          // Allow-list firewall (Part C): a valid invite is necessary but not sufficient —
          // an unlisted device is denied here, so the writer is never added/confirmed.
          if (this.allowedDevices && this.allowedDevices.size > 0 && !this.allowedDevices.has(writerKey)) {
            req.deny(); // status 1 → candidate throws PAIRING_REJECTED
            this.audit?.record({ event: "pairing", extra: { role: "host", rejected: true, writerKey } });
            return;
          }
          if (!this.base.writable) throw new Error("host mesh not writable — cannot append the add-writer record");
          await this.base.append({ type: "add-writer", key: writerKey });
          req.confirm({ key: this.base.key });
          this.audit?.record({ event: "pairing", extra: { role: "host", writerKey } });
        } catch (err) {
          // NEVER leave the candidate hanging: a failed admission (non-writable mesh, append
          // error) must DENY so the joiner gets a fast PAIRING_REJECTED instead of an
          // infinite "pairing…" wait on its end.
          this.audit?.record({ event: "pairing", extra: { role: "host", phase: "onadd-failed", error: String(err) } });
          try {
            req.deny();
          } catch {
            /* channel already gone */
          }
        }
      },
    });
    await this.member.flushed();
    const inviteHex = b4a.toString(invite, "hex");
    this.audit?.record({ event: "pairing", extra: { role: "host", invite: inviteHex } });
    return inviteHex;
  }

  /**
   * Edge first-time pairing: pair against an invite, returning a MeshGraph whose
   * base is bootstrapped against the host's autobase and joined to the swarm. The
   * host promotes us to a writer (the add-writer entry replicates in shortly after).
   */
  static async pair(opts: PairOptions): Promise<MeshGraph> {
    if (!opts.store && !opts.storeDir) throw new Error("MeshGraph.pair needs `storeDir` or an injected `store`");
    const store = opts.store ?? makeStore(opts.storeDir as string);
    const ownsStore = !opts.store;
    await store.ready();
    const swarm = opts.sharedSwarm ?? new Hyperswarm();
    const ownsSwarm = !opts.sharedSwarm;
    // Own swarm → register replication here; shared swarm → the MeshHost already did, once, on root.
    if (ownsSwarm) swarm.on("connection", (conn) => { store.replicate(conn); });
    const pairing = new BlindPairing(swarm);
    const localCore = Autobase.getLocalCore(store);
    await localCore.ready();
    const userData = b4a.from(localCore.key); // hand our writer key to the host
    await localCore.close();
    const candidate = pairing.addCandidate({ invite: b4a.from(opts.invite, "hex"), userData, onadd: () => {} });
    // `candidate.pairing` resolves only when the HOST confirms (rejects on deny). A host that
    // errors mid-admission (e.g. a non-writable mesh failing its add-writer append) does
    // neither — without a deadline the joiner would await forever, leaking the swarm and
    // holding the store open. Time out, clean up fully, and surface a real error instead.
    const timeoutMs = opts.timeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { key: Buffer };
    try {
      result = (await Promise.race([
        candidate.pairing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `pairing not confirmed within ${Math.round(timeoutMs / 1000)}s — the host accepted the PIN but never admitted this device (its mesh may not be writable; if its peers are gone, Reset mesh on the host and pair fresh)`,
                ),
              ),
            timeoutMs,
          );
          if (typeof timer.unref === "function") timer.unref();
        }),
      ])) as { key: Buffer };
    } catch (err) {
      await candidate.close().catch(() => undefined);
      await pairing.close().catch(() => undefined);
      // Only dispose what WE created — never touch a MeshHost's shared swarm / root store. On a
      // shared swarm the candidate never joined a topic yet (join happens only after success),
      // so closing the candidate above is the full cleanup.
      if (ownsSwarm) await swarm.destroy().catch(() => undefined);
      if (ownsStore) await store.close().catch(() => undefined);
      opts.audit?.record({ event: "pairing", extra: { role: "candidate", failed: true, error: String(err) } });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await candidate.close();
    await pairing.close();

    const g = MeshGraph.build(store, result.key, opts.audit);
    g.swarm = swarm;
    g.ownsStore = ownsStore;
    g.ownsSwarm = ownsSwarm;
    if (!ownsSwarm) g.externalSwarm = swarm;
    await g.base.ready();
    swarm.join(g.base.discoveryKey);
    await swarm.flush();
    opts.audit?.record({ event: "pairing", extra: { role: "candidate", autobaseKey: b4a.toString(result.key, "hex") } });
    return g;
  }

  // ── Layer-4 adapter distribution ────────────────────────────────────────────────
  // Bytes ride a sibling Hypercore (the corestore replicates all its cores); only the
  // tiny AdapterMeta pointer rides the Autobase. Honors "Autobase = nodes only".

  /**
   * Publish a trained LoRA adapter to the mesh: chunk the gguf onto the sibling
   * `adapter-feed` Hypercore (block 0 of its range = the manifest), then append a tiny
   * pointer to the CRDT. Optionally mirror the manifest to disk so the WEB layer reads
   * a plain file (never the corestore). Requires a writable mesh.
   */
  async publishAdapter(opts: {
    ggufPath: string;
    version: string;
    baseModel: string;
    evalDelta: number;
    /** Object written to block 0 (defaults to a minimal manifest). */
    manifest?: unknown;
    /** If set, write the manifest JSON here too (the web reads this, not the corestore). */
    manifestMirrorPath?: string;
  }): Promise<AdapterMeta> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot publish an adapter");
    const bytes = readFileSync(opts.ggufPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sizeBytes = bytes.length;

    const feed = this.store.get({ name: "adapter-feed" });
    await feed.ready();
    const startBlock = feed.length;

    const manifestObj = opts.manifest ?? { version: opts.version, baseModel: opts.baseModel, evalDelta: opts.evalDelta, sha256, sizeBytes };
    const blocks: Buffer[] = [b4a.from(JSON.stringify(manifestObj))];
    for (let off = 0; off < bytes.length; off += ADAPTER_CHUNK) blocks.push(bytes.subarray(off, Math.min(off + ADAPTER_CHUNK, bytes.length)));
    await feed.append(blocks);

    const meta: AdapterMeta = {
      version: opts.version,
      baseModel: opts.baseModel,
      evalDelta: opts.evalDelta,
      sha256,
      sizeBytes,
      feedKey: b4a.toString(feed.key, "hex"),
      startBlock,
      blockCount: blocks.length,
      chunkSize: ADAPTER_CHUNK,
      publishedAt: new Date().toISOString(),
    };
    await this.base.append({ type: "adapter", meta });

    if (opts.manifestMirrorPath) {
      mkdirSync(dirname(opts.manifestMirrorPath), { recursive: true });
      writeFileSync(opts.manifestMirrorPath, JSON.stringify(manifestObj, null, 2) + "\n");
    }
    this.audit?.record({ event: "adapter_publish", extra: { version: meta.version, sizeBytes, blocks: meta.blockCount, feedKey: meta.feedKey, evalDelta: meta.evalDelta } });
    return meta;
  }

  /** The newest adapter pointer in the replicated view (or null). update() never blocks on peers. */
  async latestAdapter(): Promise<AdapterMeta | null> {
    await this.base.update();
    const rec = (await this.base.view.get("adapter:latest")) as { value?: AdapterMeta } | null;
    return rec?.value ?? null;
  }

  /**
   * Fetch the latest published adapter to `destDir`: read the pointer → open the feed
   * core by key → BOUNDED download of its block range (R6) → reassemble → verify sha256
   * (rejects a corrupt/tampered/truncated transfer) → write `adapter.gguf` + `manifest.json`.
   * Returns null when no adapter has been published yet.
   */
  async fetchLatestAdapter(opts: { destDir: string; timeoutMs?: number }): Promise<{ version: string; ggufPath: string; manifestPath: string; meta: AdapterMeta } | null> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const meta = await this.latestAdapter();
    if (!meta) return null;

    const feed = this.store.get({ key: b4a.from(meta.feedKey, "hex") });
    await feed.ready();
    const blocks = await fetchRange(feed, meta.startBlock, meta.blockCount, timeoutMs);

    const manifestBuf = blocks[0]; // block 0 of the range = manifest
    const ggufBuf = blocks.length > 1 ? Buffer.concat(blocks.slice(1)) : Buffer.alloc(0);
    verifyAdapterBytes(ggufBuf, meta); // throws on sha256/size mismatch

    mkdirSync(opts.destDir, { recursive: true });
    const ggufPath = join(opts.destDir, "adapter.gguf");
    const manifestPath = join(opts.destDir, "manifest.json");
    writeFileSync(ggufPath, ggufBuf);
    if (manifestBuf) writeFileSync(manifestPath, manifestBuf);

    this.audit?.record({ event: "adapter_fetch", extra: { version: meta.version, status: "ok", sha256: meta.sha256, sizeBytes: meta.sizeBytes } });
    return { version: meta.version, ggufPath, manifestPath, meta };
  }

  // ── Plugin distribution ──────────────────────────────────────────────────────────
  // The plugin analogue of the adapter path above: zip bytes ride a SIBLING `plugin-feed`
  // Hypercore (kept separate from `adapter-feed`), and only the tiny MeshPluginMeta pointer
  // touches the Autobase. Difference from adapters: a PER-ID catalog (`plugin:<id>`) — many
  // plugins coexist; there is no single "latest" winner.

  /**
   * Publish a plugin bundle to the mesh: chunk the zip `bytes` onto the sibling `plugin-feed`
   * Hypercore (block 0 of its range = the manifest JSON), then append a tiny `plugin` pointer to
   * the CRDT keyed by `meta.pluginId`. The caller supplies the catalog fields (id/name/version/
   * description) plus the verified `sha256`/`size`; the blob coords are filled here. Requires a
   * writable mesh.
   */
  async publishPlugin(
    meta: Pick<MeshPluginMeta, "pluginId" | "name" | "version" | "description" | "sha256" | "size">,
    bytes: Buffer,
  ): Promise<MeshPluginMeta> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot publish a plugin");
    if (bytes.length !== meta.size) throw new Error(`plugin size mismatch: ${bytes.length} != ${meta.size} bytes`);

    const feed = this.store.get({ name: "plugin-feed" });
    await feed.ready();
    const startBlock = feed.length;

    const manifestObj = { pluginId: meta.pluginId, name: meta.name, version: meta.version, description: meta.description, sha256: meta.sha256, size: meta.size };
    const blocks: Buffer[] = [b4a.from(JSON.stringify(manifestObj))];
    for (let off = 0; off < bytes.length; off += PLUGIN_CHUNK) blocks.push(bytes.subarray(off, Math.min(off + PLUGIN_CHUNK, bytes.length)));
    await feed.append(blocks);

    const full: MeshPluginMeta = {
      pluginId: meta.pluginId,
      name: meta.name,
      ...(meta.version ? { version: meta.version } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      sha256: meta.sha256,
      size: meta.size,
      feedKey: b4a.toString(feed.key, "hex"),
      startBlock,
      blockCount: blocks.length,
      chunkSize: PLUGIN_CHUNK,
      publishedAt: new Date().toISOString(),
    };
    await this.base.append({ type: "plugin", meta: full });
    this.audit?.record({ event: "note", extra: { role: "plugin_publish", pluginId: full.pluginId, size: full.size, blocks: full.blockCount, feedKey: full.feedKey } });
    return full;
  }

  /** Every published plugin's catalog row in the replicated view. update() never blocks on peers (R6). */
  async listPlugins(): Promise<MeshPluginMeta[]> {
    await this.base.update();
    const out: MeshPluginMeta[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "plugin:", lt: "plugin;" })) out.push(value as MeshPluginMeta);
    return out;
  }

  /**
   * Fetch a published plugin's bytes by id: read the `plugin:<id>` pointer → open the feed core by
   * key → BOUNDED download of its block range (R6) → reassemble the zip → VERIFY sha256+size
   * (rejects a corrupt/tampered/truncated transfer) → return the bytes. Returns null when no plugin
   * with that id has been published.
   */
  async fetchPlugin(pluginId: string, opts: { timeoutMs?: number } = {}): Promise<{ bytes: Buffer; meta: MeshPluginMeta } | null> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    await this.base.update();
    const rec = (await this.base.view.get("plugin:" + pluginId)) as { value?: MeshPluginMeta } | null;
    const meta = rec?.value;
    if (!meta) return null;

    const feed = this.store.get({ key: b4a.from(meta.feedKey, "hex") });
    await feed.ready();
    const blocks = await fetchRange(feed, meta.startBlock, meta.blockCount, timeoutMs);

    const zipBuf = blocks.length > 1 ? Buffer.concat(blocks.slice(1)) : Buffer.alloc(0); // block 0 = manifest
    verifyBytes(zipBuf, { sha256: meta.sha256, size: meta.size }, "plugin"); // throws on sha256/size mismatch

    this.audit?.record({ event: "note", extra: { role: "plugin_fetch", pluginId: meta.pluginId, status: "ok", sha256: meta.sha256, size: meta.size } });
    return { bytes: zipBuf, meta };
  }

  async close(): Promise<void> {
    if (this.member) await this.member.close();
    if (this.pairing) await this.pairing.close();
    if (this.swarm) {
      if (this.ownsSwarm) await this.swarm.destroy();
      // Shared swarm: leave THIS mesh's topic but never destroy it — the MeshHost owns its
      // lifecycle (and other meshes are still riding it).
      else await this.swarm.leave(this.base.discoveryKey).catch(() => undefined);
    }
    await this.base.close();
    if (this.ownsStore) await this.store.close(); // injected store → the MeshHost owns close()
  }
}
