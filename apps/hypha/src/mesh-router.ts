/**
 * MeshRouter — the consumer-side delegation ladder across this device's meshes (spec §6).
 *
 * The shim asks "who answers this prompt?"; the router walks the device's meshes in tier order,
 * honoring the request's eligibility cap (privacy class / hard pin), and returns the warm peer in
 * the highest eligible tier — falling through only on capacity AND eligibility. The decision is the
 * pure, tested `routeDelegation`; this class just adapts live per-mesh warm pools into its inputs
 * and aggregates the /peers + /health views.
 */
import { routeDelegation, type MeshCandidate } from "@mycelium/mesh";
import type { Sensitivity, SettlementEndpoint, Visibility } from "@mycelium/shared";
import { isPaidSessionPeer, type WarmPool, type PeerView } from "./warm-pool.ts";

/** The per-peer settlement context a metered forward request needs (B4): which mesh to settle through,
 *  this device's writer key in it, the peer's modelSrc, and whether the peer advertises a paid rail. */
export interface ForwardSettlementMeta {
  meshId: string;
  consumerWriterKey: string;
  modelSrc?: string;
  requiresSession: boolean;
}

/** One live mesh the router can delegate into: its tier/visibility metadata + its warm pool. */
export interface RouterMesh {
  meshId: string;
  label: string;
  tier: number;
  visibility: Visibility;
  selfWriterKey: string;
  /** The mesh's shared Autobase key — identical on every member (unlike `meshId`, a per-device label). */
  autobaseKey: string;
  pool: WarmPool;
}

export interface ChatRouteReq {
  alias: string;
  /** Privacy class (default private/fail-closed). */
  sensitivity?: Sensitivity;
  /** Hard pin to one mesh (never fall through). */
  pinMeshId?: string;
  maxTier?: number;
  /** Conductor's exact peer pick (advisory). When set and the peer is reachable for `alias`, it is
   *  preferred over the tier walk; if not reachable, routing falls back to the normal ladder. */
  pinPeerKey?: string;
}
export interface ChatRouteHit {
  meshId: string;
  peerKey: string;
  consumerWriterKey: string;
  modelId?: string;
  modelSrc?: string;
  requiresSession?: boolean;
  settlement?: SettlementEndpoint;
  settlements?: SettlementEndpoint[];
}

export class MeshRouter {
  /** `meshes` is a live getter so the router always reflects the current membership set. */
  constructor(private readonly meshes: () => RouterMesh[]) {}

  online(): boolean {
    return this.meshes().length > 0;
  }

  /** Pick a warm delegated target for the request via the tier ladder + eligibility cap. */
  route(req: ChatRouteReq): ChatRouteHit | null {
    const meshes = this.meshes();
    // Advisory peer pin: when pinPeerKey is set, pass it into targetForAlias so each mesh returns
    // the pinned peer directly if it is warm for this alias in that mesh (exact providerPublicKey
    // equality — not just the lowest-inflight representative). The mesh whose pool returns the
    // pinned target then sorts to the front of orderedMeshes so routeDelegation sees it first.
    // Falls through to the normal tier walk when the pin is absent, unknown, or not warm anywhere.
    const orderedMeshes = req.pinPeerKey
      ? [...meshes].sort((a, b) => {
          const aPin = a.pool.targetForAlias(req.alias, req.pinPeerKey)?.peerKey === req.pinPeerKey ? -1 : 0;
          const bPin = b.pool.targetForAlias(req.alias, req.pinPeerKey)?.peerKey === req.pinPeerKey ? 1 : 0;
          return aPin + bPin;
        })
      : meshes;
    const candidates: MeshCandidate[] = orderedMeshes.map((m) => {
      const w = m.pool.targetForAlias(req.alias, req.pinPeerKey);
      return {
        meshId: m.meshId,
        tier: m.tier,
        visibility: m.visibility,
        // Propagate modelSrc + requiresSession so routeDelegation can carry the paid-session
        // contract through to the shim. A paid (registry-session) peer's target has NO modelId
        // (it's loaded on-demand AFTER the session grant); dropping these fields here made the
        // shim fall to the non-session path with an undefined modelId → "no delegated model is ready".
        ...(w ? { warm: { modelId: w.modelId, modelSrc: w.modelSrc, requiresSession: w.requiresSession, peerKey: w.peerKey, inflight: w.inflight } } : {}),
      };
    });
    const r = routeDelegation(req, candidates);
    if (!("meshId" in r)) return null;
    const mesh = this.meshes().find((m) => m.meshId === r.meshId);
    if (!mesh) return null;
    const cap = mesh?.pool.capabilityForProviderKey(r.peerKey);
    return {
      meshId: r.meshId,
      modelId: r.modelId,
      modelSrc: r.modelSrc,
      peerKey: r.peerKey,
      consumerWriterKey: mesh.selfWriterKey,
      ...(r.requiresSession ? { requiresSession: true } : {}),
      ...(r.requiresSession ? { settlement: cap?.settlement, settlements: cap?.settlements } : {}),
    };
  }

  /**
   * Ordered list of live peers that SERVE `alias` over the forward transport (lowest-inflight first,
   * deduped across meshes). Unlike route(), this needs neither a delegated warm nor the `borrowable`
   * flag — forward borrows from the peer's LOCAL serve, so any peer serving the alias qualifies. Walks
   * meshes in tier order, honors a hard mesh pin, fails closed on privacy (a private request never
   * falls to a public mesh). The list lets the shim fail over to the next peer when one errors.
   */
  forwardTargetsForAlias(req: { alias: string; sensitivity?: Sensitivity; pinMeshId?: string; pinPeerKey?: string }): string[] {
    const meshes = [...this.meshes()].sort((a, b) => a.tier - b.tier);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of meshes) {
      if (req.pinMeshId && m.meshId !== req.pinMeshId) continue;
      if (!req.pinMeshId && req.sensitivity !== "shareable" && m.visibility === "public") continue;
      for (const peerKey of m.pool.forwardTargetsForAlias(req.alias)) {
        if (!seen.has(peerKey)) { seen.add(peerKey); out.push(peerKey); }
      }
    }
    // Advisory peer pin: move the pinned key to the front when it is present in the candidate list.
    // Use the already-built seen Set (O(1)) rather than out.includes() (O(n)).
    if (req.pinPeerKey && seen.has(req.pinPeerKey)) {
      return [req.pinPeerKey, ...out.filter((k) => k !== req.pinPeerKey)];
    }
    return out;
  }

  /**
   * Settlement context for a forward peer chosen by {@link forwardTargetsForAlias} (B4 metering). Finds
   * the lowest-tier mesh whose pool holds this peer's capability and returns the meshId + this device's
   * writer key in it + the peer's modelSrc + whether it advertises a paid rail. null if the peer is gone.
   */
  forwardSettlementMeta(alias: string, peerKey: string): ForwardSettlementMeta | null {
    for (const m of [...this.meshes()].sort((a, b) => a.tier - b.tier)) {
      const cap = m.pool.capabilityForProviderKey(peerKey);
      if (!cap) continue;
      const modelSrc = cap.models?.find((x) => x.alias === alias)?.modelSrc;
      return {
        // Send the SHARED autobase key, not the local meshId label — a secondary mesh has a different
        // meshId on each device, so a label would fail the provider's membership check. The provider
        // resolves this key to its own runtime (resolveMeshParticipant falls back to autobaseKey match).
        meshId: m.autobaseKey,
        consumerWriterKey: m.selfWriterKey,
        ...(modelSrc ? { modelSrc } : {}),
        requiresSession: isPaidSessionPeer(cap, m.visibility),
      };
    }
    return null;
  }

  /** Drop a dead warm entry (TTFB timeout) across every mesh holding it. */
  dropWarm(modelId: string): void {
    for (const m of this.meshes()) m.pool.dropWarm(modelId);
  }

  /** Union of warm aliases across all meshes (the broker's "a warm peer serves this" check). */
  warmAliases(): string[] {
    const s = new Set<string>();
    for (const m of this.meshes()) for (const a of m.pool.warmAliases()) s.add(a);
    return [...s];
  }

  /** Every peer across every mesh, annotated with the mesh tier and visibility it belongs to. */
  peers(): Array<PeerView & { meshId: string; meshLabel: string; visibility: Visibility; tier: number }> {
    return this.meshes().flatMap((m) => m.pool.peers().map((p) => ({ ...p, meshId: m.meshId, meshLabel: m.label, visibility: m.visibility, tier: m.tier })));
  }
}
