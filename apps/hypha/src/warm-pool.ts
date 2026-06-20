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
import type { AuditLog, DeviceCapability, SettlementEndpoint, Visibility } from "@mycelium/shared";
import { liveProviders, loadDelegated } from "@mycelium/mesh";
import { descriptorFor } from "./catalog.ts";
import { advertisedPriceForMesh, requiresPaidSessionForMesh } from "./mesh-economy-policy.ts";

interface WarmEntry {
  peerKey: string;
  alias: string;
  modelSrc: string;
  modelId: string;
  warmedAt: number;
}

interface DelegationTarget {
  peerKey: string;
  inflight: number;
  modelId?: string;
  modelSrc?: string;
  requiresSession?: boolean;
}

export interface PeerView {
  deviceId: string;
  displayName: string;
  /** Truncated (16-char) provider public key — the SAME prefix `MeshEvent.peer` carries, so a
   *  live-mesh viz can match a routing event to the exact node it lit up. Absent on a pre-viz peer. */
  peerId?: string;
  /** Full provider public key — required for mesh-router pin matching (capabilityForProviderKey uses
   *  exact equality on providerPublicKey). Consumers MUST use this field (not peerId) when constructing
   *  a peer pin. Name mirrors the `self.providerKey` field in the /peers response envelope. */
  providerKey?: string;
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  /** Aliases this peer serves. */
  models: string[];
  /** Per-model modality + borrowable tag (SP2) — for the UI chips; absent on a pre-SP2 peer. */
  modelInfo?: { alias: string; modelType: string; borrowable: boolean }[];
  /** Aliases we currently hold a warm delegated model for. */
  warmModels: string[];
  live: boolean;
  warm: boolean;
  lastSeen: string;
  settlement?: SettlementEndpoint;
  settlements?: SettlementEndpoint[];
  /** Reputation (present only when HYPHA_REPUTATION wires a ranker) — for the Economy UI. */
  reputationScore?: number;
  effectiveCost?: number;
  pricePerKiloToken?: number;
  /** Whether this peer shares its cached models with the mesh (advisory; gates the pull affordance). */
  shareModels?: boolean;
}

/** Reputation ranker the warm pool consumes for paid-target ordering + `/peers` display. */
export interface ReputationRanker {
  /** price ÷ quality — lower is preferred (paid targets). */
  effectiveCost(peerKey: string, pricePerKiloToken: number): number;
  /** Headline score for display, or undefined if the provider is unseen. */
  score(peerKey: string): number | undefined;
}

export interface WarmPoolDeps {
  /** Read every device's latest replicated capability. */
  caps: () => Promise<DeviceCapability[]>;
  /** Mesh visibility drives economy semantics: private is always free; public may be free or paid. */
  visibility: Visibility;
  /** This device's own provider/consumer public key (excluded from peer selection). */
  selfKey: string;
  staleMs: number;
  tickMs: number;
  audit?: AuditLog;
  /**
   * Called for every live PAID-session provider seen on a reconcile tick. Paid peers are never
   * pre-warmed at the model layer (loaded on-demand after a session grant), but the payment-control
   * client uses this to pre-establish its persistent P2P connection so the cold holepunch is
   * absorbed before the user triggers a paid completion.
   */
  onPaidPeer?: (providerKey: string) => void;
  /**
   * Reputation-weighted routing (HYPHA_REPUTATION). When present, PAID targets are tie-broken by
   * effective_cost = price / quality (free/warm peers stay first; the proven inflight order is the
   * fallback). Absent → the exact legacy inflight-first sort (no behavior change).
   */
  reputation?: ReputationRanker;
}

const key = (peerKey: string, modelSrc: string): string => `${peerKey}::${modelSrc}`;
const uptoRail = (cap: DeviceCapability): SettlementEndpoint | undefined =>
  (cap.settlements ?? (cap.settlement ? [cap.settlement] : [])).find((rail) => rail.network === "plasma" && rail.x402?.scheme === "upto" && (rail.x402.pricePerKiloToken ?? 0) > 0);
export const isPaidSessionPeer = (cap: DeviceCapability, visibility: Visibility = "public"): boolean => {
  const rail = uptoRail(cap);
  return requiresPaidSessionForMesh(visibility, rail?.x402?.pricePerKiloToken ?? 0, rail !== undefined);
};

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

    // Pre-warm every unpaid (live peer, chat alias) we don't already hold. Paid peers are
    // registered on-demand after the provider grants a session, never speculatively.
    for (const peer of live) {
      const pk = peer.providerPublicKey;
      if (!pk) continue;
      if (isPaidSessionPeer(peer, this.deps.visibility)) {
        // Pre-warm the payment-control connection (not the model — paid models load on-demand).
        this.deps.onPaidPeer?.(pk);
        continue;
      }
      for (const m of peer.models ?? []) {
        if (m.borrowable === false) continue;
        // Only CHAT delegates (loadDelegated carries completion()); vision/embed/stt/tts borrow over the
        // FORWARD transport (forwardTargetForAlias), so don't speculatively delegate-warm them.
        if (m.modelType !== undefined && m.modelType !== "chat") continue;
        const k = key(pk, m.modelSrc);
        if (this.warm.has(k) || this.warming.has(k)) continue;
        this.warming.add(k);
        void this.warmOne(pk, m.alias, m.modelSrc, m.modelType, m.projectionModelSrc).finally(() => this.warming.delete(k));
      }
    }
  }

  private async warmOne(peerKey: string, alias: string, modelSrc: string, modelType?: string, projectionModelSrc?: string): Promise<void> {
    try {
      const vision = modelType === "vision";
      const modelId = await loadDelegated({
        modelSrc: descriptorFor(modelSrc) as never, // string | descriptor — both valid modelSrc
        providerPublicKey: peerKey,
        timeout: 60_000,
        fallbackToLocal: false,
        tools: false,
        // Vision (qwen3vl): load the provider's projection model + a roomier ctx (images cost tokens).
        ...(vision ? { ctxSize: 8192, ...(projectionModelSrc ? { projectionModelSrc } : {}) } : {}),
        audit: this.deps.audit,
      });
      this.warm.set(key(peerKey, modelSrc), { peerKey, alias, modelSrc, modelId, warmedAt: Date.now() });
      this.deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "warmed", peer: peerKey.slice(0, 16), alias } });
    } catch (err) {
      // A peer that dies mid-warm simply isn't a shed target — logged, not fatal.
      this.deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "warm-failed", peer: peerKey.slice(0, 16), alias, error: String(err) } });
    }
  }

  /**
   * A warm delegated modelId for `alias`, picking the lowest-inflight live peer. `inflight` is
   * returned too so a cross-mesh tier router can tie-break between meshes at the same tier.
   *
   * `preferPeerKey` (optional): when set to a full `providerPublicKey`, if a candidate whose
   * `peerKey === preferPeerKey` exists in this pool for `alias` it is returned directly (bypassing
   * inflight / reputation sort). Unset or no-match falls through to the normal selection unchanged.
   */
  targetForAlias(alias: string, preferPeerKey?: string): DelegationTarget | undefined {
    const inflightOf = (pk: string): number => this.lastCaps.find((c) => c.providerPublicKey === pk)?.inflight ?? 0;
    const warmCandidates = [...this.warm.values()]
      .filter((e) => e.alias === alias)
      .map((e) => ({ peerKey: e.peerKey, inflight: inflightOf(e.peerKey), modelId: e.modelId, modelSrc: e.modelSrc } satisfies DelegationTarget));
    const paidCandidates = this.livePeers(this.lastCaps)
      .filter((c) => isPaidSessionPeer(c, this.deps.visibility))
      .flatMap((c) => {
        const peerKey = c.providerPublicKey;
        if (!peerKey) return [];
        return (c.models ?? [])
          .filter((m) => m.alias === alias && m.borrowable !== false)
          .map((m) => ({ peerKey, inflight: c.inflight ?? 0, modelSrc: m.modelSrc, requiresSession: true } satisfies DelegationTarget));
      });
    const candidates: DelegationTarget[] = [...warmCandidates, ...paidCandidates];
    if (candidates.length === 0) return undefined;
    // Per-peer pin: if the caller requests a specific peer and we hold it warm for this alias,
    // return it immediately (exact providerPublicKey equality) without re-sorting.
    if (preferPeerKey) {
      const pinned = candidates.find((c) => c.peerKey === preferPeerKey);
      if (pinned) return pinned;
    }
    const rep = this.deps.reputation;
    if (rep) {
      // Reputation-weighted: free/warm peers (no session) first — the proven free path is untouched;
      // among PAID targets, lowest effective_cost (price / quality) wins; inflight is the tie-break.
      const ec = (t: DelegationTarget): number => rep.effectiveCost(t.peerKey, this.priceOf(t.peerKey));
      candidates.sort((a, b) => {
        const af = a.requiresSession ? 1 : 0;
        const bf = b.requiresSession ? 1 : 0;
        if (af !== bf) return af - bf;
        if (af === 1) {
          const d = ec(a) - ec(b);
          if (d !== 0) return d;
        }
        return a.inflight - b.inflight;
      });
    } else {
      candidates.sort((a, b) => a.inflight - b.inflight || Number(Boolean(a.requiresSession)) - Number(Boolean(b.requiresSession)));
    }
    return candidates[0];
  }

  /**
   * Live peers (excl. self) that SERVE `alias`, lowest-inflight first — for the forward path, which
   * borrows via the peer's LOCAL serve and so needs neither a warm delegated model nor the
   * (delegation-only) `borrowable` flag. The ordered list lets the shim fail over to the next capable
   * peer when one errors.
   */
  forwardTargetsForAlias(alias: string): string[] {
    return this.livePeers(this.lastCaps)
      .filter((c) => c.providerPublicKey && (c.models ?? []).some((m) => m.alias === alias))
      .map((c) => ({ peerKey: c.providerPublicKey as string, inflight: c.inflight ?? 0 }))
      .sort((a, b) => a.inflight - b.inflight)
      .map((c) => c.peerKey);
  }

  /** Advertised price/kilo-token for a paid peer (0 = free/warm, sorts first). */
  private priceOf(peerKey: string): number {
    const cap = this.lastCaps.find((c) => c.providerPublicKey === peerKey);
    return cap ? advertisedPriceForMesh(this.deps.visibility, uptoRail(cap)?.x402?.pricePerKiloToken ?? 0) : 0;
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

  /** Live provider keys (excl. self) — the connectivity manager probes these for liveness. */
  livePeerKeys(): string[] {
    return this.livePeers(this.lastCaps)
      .map((c) => c.providerPublicKey)
      .filter((k): k is string => !!k && k !== this.deps.selfKey);
  }

  /** Drop every warm entry and re-warm from scratch — used after an SDK transport reset
   *  (suspend()+resume()) so stale delegated model handles can't linger. */
  async rewarmAll(): Promise<void> {
    this.warm.clear();
    await this.reconcile();
  }

  /** Aliases we currently hold warm (the broker's "a warm peer serves this alias" check). */
  warmAliases(): Set<string> {
    const aliases = new Set([...this.warm.values()].map((e) => e.alias));
    for (const peer of this.livePeers(this.lastCaps)) {
      if (!isPaidSessionPeer(peer, this.deps.visibility)) continue;
      for (const model of peer.models ?? []) if (model.borrowable !== false) aliases.add(model.alias);
    }
    return aliases;
  }

  /** The latest advertised capability for one provider key, if we have it. */
  capabilityForProviderKey(providerKey: string): DeviceCapability | undefined {
    return this.lastCaps.find((c) => c.providerPublicKey === providerKey);
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
        const price = advertisedPriceForMesh(this.deps.visibility, uptoRail(c)?.x402?.pricePerKiloToken ?? 0);
        const rep = this.deps.reputation;
        return {
          deviceId: c.deviceId,
          displayName: c.displayName,
          peerId: c.providerPublicKey!.slice(0, 16),
          providerKey: c.providerPublicKey!,
          computeClass: c.computeClass,
          ramMB: c.ramMB,
          powerState: c.powerState,
          inflight: c.inflight ?? 0,
          models: (c.models ?? []).map((m) => m.alias),
          modelInfo: (c.models ?? []).map((m) => ({ alias: m.alias, modelType: m.modelType ?? "chat", borrowable: m.borrowable ?? true })),
          warmModels: [...warmSet],
          live: liveKeys.has(c.providerPublicKey!),
          warm: warmSet.size > 0,
          lastSeen: c.lastSeen,
          settlement: c.settlement,
          settlements: c.settlements,
          shareModels: c.shareModels ?? true,
          pricePerKiloToken: price,
          ...(rep ? { reputationScore: rep.score(c.providerPublicKey!), effectiveCost: rep.effectiveCost(c.providerPublicKey!, price) } : {}),
        } satisfies PeerView;
      });
  }
}
