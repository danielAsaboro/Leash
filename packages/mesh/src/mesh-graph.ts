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
import { randomUUID } from "node:crypto";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import Hyperswarm from "hyperswarm";
import BlindPairing from "blind-pairing";
import b4a from "b4a";
import type { GraphNode, GraphNodeInput, AuditLog } from "@mycelium/shared";

type Entry = { type: "node"; node: GraphNode } | { type: "add-writer"; key: string };

export interface MeshGraphOptions {
  /** Directory for the corestore (one per device/role). */
  storeDir: string;
  /**
   * Existing autobase key to boot against. Usually omitted: a fresh store founds a
   * new mesh (the hub); a previously-paired store recovers its base automatically
   * via the local core's `referrer` (the edge on reopen).
   */
  bootstrapKey?: Buffer | null;
  /** Whether to stand up our own Hyperswarm (false for local-only tests). */
  swarm?: boolean;
  audit?: AuditLog;
}

export interface PairOptions {
  storeDir: string;
  /** Hex blind-pairing invite minted by the host's mintInvite(). */
  invite: string;
  audit?: AuditLog;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The autobase view: a Hyperbee keyed by node.id (idempotent grow-only set). */
function viewOpen(store: unknown) {
  return new Hyperbee((store as Corestore).get("view"), { keyEncoding: "utf-8", valueEncoding: "json" });
}
/** The entire CRDT: two idempotent entry shapes. (No view.flush — plain Hyperbee put is durable.) */
async function viewApply(nodes: Array<{ value: Entry }>, view: unknown, host: { addWriter(key: Buffer, opts?: { indexer?: boolean }): Promise<void> }) {
  const bee = view as Hyperbee;
  for (const { value } of nodes) {
    if (value?.type === "add-writer") { await host.addWriter(b4a.from(value.key, "hex"), { indexer: true }); continue; }
    if (value?.type === "node") await bee.put(value.node.id, value.node);
  }
}

export class MeshGraph {
  private store: Corestore;
  private base: Autobase<Entry>;
  private swarm: Hyperswarm | null = null;
  private pairing: BlindPairing | null = null;
  private member: { flushed(): Promise<void>; close(): Promise<void> } | null = null;
  private readonly audit?: AuditLog;

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
    const g = MeshGraph.build(new Corestore(opts.storeDir), opts.bootstrapKey ?? null, opts.audit);
    await g.base.ready();
    return g;
  }

  async ready(): Promise<void> { await this.base.ready(); }
  get autobaseKey(): string { return b4a.toString(this.base.key, "hex"); }
  get localWriterKey(): string { return b4a.toString(this.base.local.key, "hex"); }
  get writable(): boolean { return this.base.writable; }

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
    for await (const { value } of this.base.view.createReadStream()) out.push(value as GraphNode);
    return out;
  }

  /** Linearize whatever has locally replicated. Never blocks on peers. */
  async update(): Promise<void> { await this.base.update(); }

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
    this.swarm = new Hyperswarm();
    this.swarm.on("connection", (conn) => { this.store.replicate(conn); });
    this.swarm.join(this.base.discoveryKey);
    await this.swarm.flush();
  }

  /** Host: mint a hex invite and auto-confirm the first candidate as a writer. */
  async mintInvite(): Promise<string> {
    if (!this.swarm) throw new Error("call joinSwarm() before mintInvite()");
    const { invite, publicKey } = BlindPairing.createInvite(this.base.key);
    this.pairing = new BlindPairing(this.swarm);
    this.member = this.pairing.addMember({
      discoveryKey: this.base.discoveryKey,
      onadd: async (req) => {
        req.open(publicKey);
        const writerKey = b4a.toString(req.userData, "hex");
        await this.base.append({ type: "add-writer", key: writerKey });
        req.confirm({ key: this.base.key });
        this.audit?.record({ event: "pairing", extra: { role: "host", writerKey } });
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
    const store = new Corestore(opts.storeDir);
    await store.ready();
    const swarm = new Hyperswarm();
    swarm.on("connection", (conn) => { store.replicate(conn); });
    const pairing = new BlindPairing(swarm);
    const localCore = Autobase.getLocalCore(store);
    await localCore.ready();
    const userData = b4a.from(localCore.key); // hand our writer key to the host
    await localCore.close();
    const candidate = pairing.addCandidate({ invite: b4a.from(opts.invite, "hex"), userData, onadd: () => {} });
    const result = await candidate.pairing; // { key: autobaseKey }
    await candidate.close();
    await pairing.close();

    const g = MeshGraph.build(store, result.key, opts.audit);
    g.swarm = swarm;
    await g.base.ready();
    swarm.join(g.base.discoveryKey);
    await swarm.flush();
    opts.audit?.record({ event: "pairing", extra: { role: "candidate", autobaseKey: b4a.toString(result.key, "hex") } });
    return g;
  }

  async close(): Promise<void> {
    if (this.member) await this.member.close();
    if (this.pairing) await this.pairing.close();
    if (this.swarm) await this.swarm.destroy();
    await this.base.close();
    await this.store.close();
  }
}
