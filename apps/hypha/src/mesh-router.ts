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
import type { WarmPool, PeerView } from "./warm-pool.ts";

/** One live mesh the router can delegate into: its tier/visibility metadata + its warm pool. */
export interface RouterMesh {
  meshId: string;
  label: string;
  tier: number;
  visibility: Visibility;
  selfWriterKey: string;
  pool: WarmPool;
}

export interface ChatRouteReq {
  alias: string;
  /** Privacy class (default private/fail-closed). */
  sensitivity?: Sensitivity;
  /** Hard pin to one mesh (never fall through). */
  pinMeshId?: string;
  maxTier?: number;
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
    const candidates: MeshCandidate[] = this.meshes().map((m) => {
      const w = m.pool.targetForAlias(req.alias);
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
      settlement: cap?.settlement,
      settlements: cap?.settlements,
    };
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

  /** Every peer across every mesh, annotated with which mesh it belongs to. */
  peers(): Array<PeerView & { meshId: string; meshLabel: string }> {
    return this.meshes().flatMap((m) => m.pool.peers().map((p) => ({ ...p, meshId: m.meshId, meshLabel: m.label })));
  }
}
