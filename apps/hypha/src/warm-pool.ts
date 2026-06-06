/**
 * Consumer role — the warm pool.
 *
 * Cold DHT registration to a peer (15–45s) must NEVER happen on a request. So the moment a
 * live peer advertises a chat alias, we pre-warm it in the background via `loadDelegated`
 * and keep a `(peerKey, modelSrc) → modelId` map. The shim then answers from a warm id with
 * no cold-start; the broker only sheds to an alias we hold warm.
 *
 * Liveness is the mesh heartbeat (`lastSeen` within STALE_MS → live via `liveProviders`).
 * When a peer goes stale we drop its warm entries (the SDK has no auto-reconnect); when it
 * returns we re-warm. Models are warmed TOOLLESS (`tools:false`) and `fallbackToLocal:false`
 * — the shim does raw `completion()` (no tool execution; the TOOLLESS-HANG guard), and the
 * broker, not the SDK, is the fallback (SDK-local fallback would duplicate model RAM here).
 */
import type { AuditLog, DeviceCapability } from "@mycelium/shared";
import { liveProviders, loadDelegated } from "@mycelium/mesh";
import { descriptorFor } from "./catalog.ts";

interface WarmEntry {
  peerKey: string;
  alias: string;
  modelSrc: string;
  modelId: string;
  warmedAt: number;
}

export interface PeerView {
  deviceId: string;
  displayName: string;
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  /** Aliases this peer serves. */
  models: string[];
  /** Aliases we currently hold a warm delegated model for. */
  warmModels: string[];
  live: boolean;
  warm: boolean;
  lastSeen: string;
}

export interface WarmPoolDeps {
  /** Read every device's latest replicated capability. */
  caps: () => Promise<DeviceCapability[]>;
  /** This device's own provider/consumer public key (excluded from peer selection). */
  selfKey: string;
  staleMs: number;
  tickMs: number;
  audit?: AuditLog;
}

const key = (peerKey: string, modelSrc: string): string => `${peerKey}::${modelSrc}`;

export class WarmPool {
  private readonly warm = new Map<string, WarmEntry>();
  private readonly warming = new Set<string>();
  private lastCaps: DeviceCapability[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WarmPoolDeps) {}

  start(): void {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.deps.tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Live peers (excluding self) ordered best-first; the source of truth for warming + /peers. */
  private livePeers(caps: DeviceCapability[]): DeviceCapability[] {
    return liveProviders(caps, { staleMs: this.deps.staleMs }).filter((c) => c.providerPublicKey !== this.deps.selfKey);
  }

  /** Drop stale warm entries; pre-warm new (peer, model) pairs in the background. */
  async reconcile(): Promise<void> {
    let caps: DeviceCapability[];
    try {
      caps = await this.deps.caps();
    } catch (err) {
      this.deps.audit?.record({ event: "note", extra: { role: "warm-pool", phase: "caps-read-failed", error: String(err) } });
      return;
    }
    this.lastCaps = caps;
    const live = this.livePeers(caps);
    const liveKeys = new Set(live.map((c) => c.providerPublicKey));

    // Drop warm entries whose peer is no longer live (stale heartbeat → no auto-reconnect).
    for (const [k, e] of this.warm) {
      if (!liveKeys.has(e.peerKey)) {
        this.warm.delete(k);
        this.deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "dropped-stale", peer: e.peerKey.slice(0, 16), alias: e.alias } });
      }
    }

    // Pre-warm every (live peer, chat alias) we don't already hold.
    for (const peer of live) {
      const pk = peer.providerPublicKey;
      if (!pk) continue;
      for (const m of peer.models ?? []) {
        const k = key(pk, m.modelSrc);
        if (this.warm.has(k) || this.warming.has(k)) continue;
        this.warming.add(k);
        void this.warmOne(pk, m.alias, m.modelSrc).finally(() => this.warming.delete(k));
      }
    }
  }

  private async warmOne(peerKey: string, alias: string, modelSrc: string): Promise<void> {
    try {
      const modelId = await loadDelegated({
        modelSrc: descriptorFor(modelSrc) as never, // string | descriptor — both valid modelSrc
        providerPublicKey: peerKey,
        timeout: 60_000,
        fallbackToLocal: false,
        tools: false,
        audit: this.deps.audit,
      });
      this.warm.set(key(peerKey, modelSrc), { peerKey, alias, modelSrc, modelId, warmedAt: Date.now() });
      this.deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "warmed", peer: peerKey.slice(0, 16), alias } });
    } catch (err) {
      // A peer that dies mid-warm simply isn't a shed target — logged, not fatal.
      this.deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "warm-failed", peer: peerKey.slice(0, 16), alias, error: String(err) } });
    }
  }

  /** A warm delegated modelId for `alias`, picking the lowest-inflight live peer. */
  modelIdForAlias(alias: string): { modelId: string; peerKey: string } | undefined {
    const candidates = [...this.warm.values()].filter((e) => e.alias === alias);
    if (candidates.length === 0) return undefined;
    const inflightOf = (pk: string): number => this.lastCaps.find((c) => c.providerPublicKey === pk)?.inflight ?? 0;
    candidates.sort((a, b) => inflightOf(a.peerKey) - inflightOf(b.peerKey) || a.warmedAt - b.warmedAt);
    const best = candidates[0]!;
    return { modelId: best.modelId, peerKey: best.peerKey };
  }

  /**
   * Drop the warm entry holding `modelId` (e.g. after a TTFB timeout — the delegated load
   * registered but decode is dead). The reconcile tick re-warms the (peer, model) pair fresh.
   */
  dropWarm(modelId: string): void {
    for (const [k, e] of this.warm) {
      if (e.modelId === modelId) {
        this.warm.delete(k);
        this.deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "dropped-dead", peer: e.peerKey.slice(0, 16), alias: e.alias } });
      }
    }
  }

  /** Aliases we currently hold warm (the broker's "a warm peer serves this alias" check). */
  warmAliases(): Set<string> {
    return new Set([...this.warm.values()].map((e) => e.alias));
  }

  /** Snapshot of every known peer for `GET /peers` (live + warmth annotated). */
  peers(): PeerView[] {
    const liveKeys = new Set(this.livePeers(this.lastCaps).map((c) => c.providerPublicKey));
    const warmByPeer = new Map<string, Set<string>>();
    for (const e of this.warm.values()) {
      const s = warmByPeer.get(e.peerKey) ?? new Set<string>();
      s.add(e.alias);
      warmByPeer.set(e.peerKey, s);
    }
    return this.lastCaps
      .filter((c) => c.isProvider && c.providerPublicKey && c.providerPublicKey !== this.deps.selfKey)
      .map((c) => {
        const warmSet = warmByPeer.get(c.providerPublicKey!) ?? new Set<string>();
        return {
          deviceId: c.deviceId,
          displayName: c.displayName,
          computeClass: c.computeClass,
          ramMB: c.ramMB,
          powerState: c.powerState,
          inflight: c.inflight ?? 0,
          models: (c.models ?? []).map((m) => m.alias),
          warmModels: [...warmSet],
          live: liveKeys.has(c.providerPublicKey!),
          warm: warmSet.size > 0,
          lastSeen: c.lastSeen,
        } satisfies PeerView;
      });
  }
}
