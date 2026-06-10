/**
 * PublicMesh (Layer 1 — Mesh): a public, discoverable cell = a {@link GossipMesh} (leaderless
 * signed-gossip) on its OWN per-cell-seeded Corestore + its OWN Hyperswarm joined to the cell
 * topic. Spec §1 note / §9 / direction (B).
 *
 * Two things make it "public, no pairing":
 *   - The corestore is seeded with `deriveCellSeed(masterSeed, cellId)` — a per-cell identity,
 *     unlinkable to the device's private mesh (spec §3). It is NEVER the shared MeshHost root.
 *   - The swarm topic is `hash(cellId)`, so every device that computes the same cell id meets on
 *     the same topic with no invite. Feed-key DISCOVERY (which peer feeds exist) is injected from
 *     above — over mDNS for a local cell (apps/hypha wires it) — via `addPeerFeed`. Once a peer
 *     feed is known, the swarm connection replicates it and the gossip view merges it.
 *
 * Broadcast-only by construction: there is no compute provider here, so a public membership can
 * never widen the device's delegated-inference firewall (spec §4) — the privacy guarantee is
 * structural, not a runtime check.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import Corestore from "corestore";
import Hyperswarm from "hyperswarm";
import b4a from "b4a";
import type { AuditLog } from "@mycelium/shared";
import { GossipMesh, deriveCellSeed, type GossipMessage } from "./gossip-mesh.ts";

/** The swarm topic for a cell — a stable 32-byte hash of the cell id (geohash later). */
export function cellTopic(cellId: string): Buffer {
  return createHash("sha256").update(`mycelium-public-cell-topic:${cellId}`).digest();
}

export interface PublicMeshOptions {
  /** Directory for this cell's corestore (separate from the private MeshHost root). */
  storeDir: string;
  /** The public cell id (a geohash in Phase 3; any agreed string for the local prototype). */
  cellId: string;
  /** The device's PRIVATE master seed — mixed into the per-cell seed so the cell identity is unlinkable. */
  masterSeed: string;
  /** Stand up the Hyperswarm (false for offline smokes that drive replication by hand). */
  swarm?: boolean;
  audit?: AuditLog;
}

export class PublicMesh {
  private readonly gossip: GossipMesh;
  private readonly store: Corestore;
  private readonly swarm: Hyperswarm | null;
  private readonly topic: Buffer;
  readonly cellId: string;

  private constructor(cellId: string, gossip: GossipMesh, store: Corestore, swarm: Hyperswarm | null, topic: Buffer) {
    this.cellId = cellId;
    this.gossip = gossip;
    this.store = store;
    this.swarm = swarm;
    this.topic = topic;
  }

  static async open(opts: PublicMeshOptions): Promise<PublicMesh> {
    mkdirSync(opts.storeDir, { recursive: true });
    const seed = deriveCellSeed(opts.masterSeed, opts.cellId);
    const store = new Corestore(opts.storeDir, { primaryKey: b4a.from(seed, "hex"), unsafe: true, allowBackup: true });
    await store.ready();
    const gossip = await GossipMesh.open({ store, ...(opts.audit ? { audit: opts.audit } : {}) });
    const topic = cellTopic(opts.cellId);
    let swarm: Hyperswarm | null = null;
    if (opts.swarm !== false) {
      swarm = new Hyperswarm();
      swarm.on("connection", (conn) => { gossip.replicateConnection(conn); });
      swarm.join(topic);
      await swarm.flush();
    }
    opts.audit?.record({ event: "note", extra: { role: "public-mesh", phase: "open", cellId: opts.cellId, feed: gossip.authorKey.slice(0, 16), swarm: swarm !== null } });
    return new PublicMesh(opts.cellId, gossip, store, swarm, topic);
  }

  /** This device's author identity in this cell (its gossip feed key). */
  get feedKey(): string {
    return this.gossip.authorKey;
  }

  /** Feeds currently merged (ours + discovered peers). */
  knownFeeds(): string[] {
    return this.gossip.knownFeeds();
  }

  /** Register a peer's feed (discovered over mDNS) — it then replicates over the cell swarm. */
  addPeerFeed(feedKeyHex: string): void {
    this.gossip.addPeerFeed(feedKeyHex);
  }

  /** Broadcast a signed message into the cell (e.g. a safety alert). */
  post(kind: string, data: unknown): Promise<GossipMessage> {
    return this.gossip.post(kind, data);
  }

  /** The merged cell view — every author's messages, signed + attributed. */
  all(): Promise<GossipMessage[]> {
    return this.gossip.all();
  }

  /** Bounded best-effort wait for known peer feeds to catch up (R6). */
  sync(opts?: { timeoutMs?: number; settleMs?: number }): Promise<number> {
    return this.gossip.sync(opts);
  }

  async close(): Promise<void> {
    if (this.swarm) {
      await this.swarm.leave(this.topic).catch(() => undefined);
      await this.swarm.destroy().catch(() => undefined);
    }
    await this.gossip.close();
    await this.store.close();
  }
}
