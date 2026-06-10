/**
 * GossipMesh (Layer 1 — Mesh): the LEADERLESS, signed-gossip store for PUBLIC meshes (spec §1
 * note + §9). Autobase is wrong for a public cell — it needs a root writer + an add-writer
 * protocol, so two devices independently "founding" the same cell split-brain. GossipMesh has no
 * privileged writer at all:
 *
 *   - Each device owns ONE append-only Hypercore feed. Hypercore blocks are authenticated by the
 *     feed's keypair (the feed key IS the author's public key + a signed merkle tree), so every
 *     message is inherently signed — no separate signature field, no trusted server.
 *   - A public cell is a topic; devices replicate each OTHER's feeds and the "view" is the MERGE
 *     of all known feeds. Any author can write; nobody is the leader; presence is just "your feed
 *     replicated to me". A device leaving doesn't break anything (its feed simply stops growing).
 *
 * Identity: the feed key derives from the corestore's primaryKey, so a PUBLIC mesh must be opened
 * on a SEPARATELY-SEEDED corestore (a per-mesh key — spec §3), never the device's private root —
 * reusing the global identity on a public cell would deanonymize the private mesh.
 *
 * Feed discovery (which peer feeds exist) is the wiring on top: announced over mDNS for a LOCAL
 * cell, or a discovery feed for a wide cell. This module is that mechanism-free core: register a
 * peer feed key with `addPeerFeed`, and replication + merge handle the rest. Proven offline by
 * scripts/smoke-gossip-mesh.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import Corestore, { type Hypercore } from "corestore";
import b4a from "b4a";
import type { AuditLog } from "@mycelium/shared";

/** One merged, author-attributed message in a public cell. `author` is the feed key (its identity). */
export interface GossipMessage {
  /** Hex feed key of the author — Hypercore-authenticated; no separate signature needed. */
  author: string;
  /** Index in the author's feed (their local sequence). */
  seq: number;
  /** ISO timestamp the author stamped. */
  ts: string;
  /** Message kind (e.g. "presence", "alert"). */
  kind: string;
  /** Free-form payload. */
  data: unknown;
}

interface FeedBlock {
  ts: string;
  kind: string;
  data: unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GossipMesh {
  private readonly store: Corestore;
  private readonly ownFeed: Hypercore;
  private readonly peerFeeds = new Map<string, Hypercore>();
  private readonly audit?: AuditLog;
  private ownsStore: boolean;

  private constructor(store: Corestore, ownFeed: Hypercore, ownsStore: boolean, audit?: AuditLog) {
    this.store = store;
    this.ownFeed = ownFeed;
    this.ownsStore = ownsStore;
    this.audit = audit;
  }

  /**
   * Open a public cell on `store` (the device's writable feed = `store.get({name:"gossip-feed"})`).
   * For a real public mesh `store` MUST be per-mesh-seeded (spec §3); the smoke uses a seeded store.
   */
  static async open(opts: { store: Corestore; audit?: AuditLog }): Promise<GossipMesh> {
    const ownFeed = opts.store.get({ name: "gossip-feed" });
    await ownFeed.ready();
    return new GossipMesh(opts.store, ownFeed, false, opts.audit);
  }

  /** This device's author identity in this cell (its feed's public key). */
  get authorKey(): string {
    return b4a.toString(this.ownFeed.key, "hex");
  }

  /** Every feed we currently merge (ours first, then registered peers). */
  knownFeeds(): string[] {
    return [this.authorKey, ...this.peerFeeds.keys()];
  }

  /** Append a signed message to OUR feed (Hypercore authenticates authorship). Returns the record. */
  async post(kind: string, data: unknown): Promise<GossipMessage> {
    const block: FeedBlock = { ts: new Date().toISOString(), kind, data };
    const seq = this.ownFeed.length;
    await this.ownFeed.append(b4a.from(JSON.stringify(block)));
    this.audit?.record({ event: "note", extra: { role: "gossip", phase: "post", kind, seq, author: this.authorKey.slice(0, 16) } });
    return { author: this.authorKey, seq, ts: block.ts, kind, data };
  }

  /**
   * Register a peer's feed key (discovered over the topic / mDNS) so we replicate + merge it. No-op
   * for our own key or an already-known feed. Open join: ANY feed key is accepted (public cell).
   */
  addPeerFeed(feedKeyHex: string): void {
    if (!/^[0-9a-f]{64}$/i.test(feedKeyHex)) return;
    if (feedKeyHex === this.authorKey || this.peerFeeds.has(feedKeyHex)) return;
    const core = this.store.get({ key: b4a.from(feedKeyHex, "hex") });
    this.peerFeeds.set(feedKeyHex, core);
    // Eagerly pull the whole feed (live) so a wait-free read finds the blocks once they replicate.
    void core.ready().then(() => {
      try {
        core.download({ start: 0, end: -1 });
      } catch {
        try { core.download(); } catch { /* some builds differ — update() below still refreshes length */ }
      }
    });
    this.audit?.record({ event: "note", extra: { role: "gossip", phase: "peer-feed", feed: feedKeyHex.slice(0, 16) } });
  }

  /** The MERGE of every known feed — the full cell view, each message author-attributed + verified. */
  async all(): Promise<GossipMessage[]> {
    const out: GossipMessage[] = [];
    const feeds: Array<[string, Hypercore]> = [[this.authorKey, this.ownFeed], ...this.peerFeeds];
    for (const [author, core] of feeds) {
      const len = core.length;
      for (let i = 0; i < len; i++) {
        const blk = await core.get(i, { wait: false });
        if (!blk) continue; // not yet replicated — skip (R6: never block on peers)
        try {
          const b = JSON.parse(b4a.toString(blk)) as FeedBlock;
          out.push({ author, seq: i, ts: b.ts, kind: b.kind, data: b.data });
        } catch {
          /* a malformed block from a peer is ignored, never fatal */
        }
      }
    }
    return out;
  }

  /**
   * Bounded best-effort wait until every known peer feed has caught up to a stable length (so a
   * read after a fresh connection sees replicated messages). Returns fast offline. R6-bounded.
   */
  async sync(opts: { timeoutMs?: number; settleMs?: number } = {}): Promise<number> {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const settleMs = opts.settleMs ?? 600;
    const refresh = async (): Promise<void> => {
      // Refresh each peer feed's length from the live connection (a remote core learns its length
      // via update()); blocks were requested in addPeerFeed and arrive over the same stream.
      await Promise.all([...this.peerFeeds.values()].map((c) => c.update({ wait: true }).catch(() => false)));
    };
    const t0 = Date.now();
    await refresh();
    let last = (await this.all()).length;
    let stableSince = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(150);
      await refresh();
      const n = (await this.all()).length;
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= settleMs) break;
    }
    return last;
  }

  /** Raw replication stream over the store — for offline/loopback smokes (pipe two of these). */
  replicate(isInitiator: boolean): unknown {
    return this.store.replicate(isInitiator);
  }

  /** Replicate over a live swarm connection (every known feed rides it). Used by PublicMesh. */
  replicateConnection(conn: unknown): unknown {
    return this.store.replicate(conn);
  }

  async close(): Promise<void> {
    if (this.ownsStore) await this.store.close();
  }
}

/**
 * Derive a stable, per-cell 64-hex seed for a public mesh's corestore primaryKey — so the device's
 * feed key in a public cell is unlinkable to its private identity (spec §3). NOT the global seed.
 * `masterSeed` is the device's private root; `cellId` is the public cell (a geocell hash, later).
 */
export function deriveCellSeed(masterSeed: string, cellId: string): string {
  return createHash("sha256").update(`mycelium-public-cell:${masterSeed}:${cellId}`).digest("hex");
}

/** A throwaway cell id for smokes/demos (a real cell id is a geocell hash — Phase 3). */
export const ephemeralCellId = (): string => randomUUID();
