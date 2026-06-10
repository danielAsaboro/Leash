/**
 * Multi-mesh delegation policy (Layer 1 — Mesh). Spec §4 (union firewall) + §6 (delegation
 * ladder + eligibility). PURE functions — no I/O, no SDK — so they are exhaustively unit-smokeable
 * and the daemon just feeds them live state.
 *
 * Two decisions live here:
 *   - PROVIDER side: which consumer keys the device-global SDK provider should allow — the UNION
 *     across every mesh where this device serves compute (§4).
 *   - CONSUMER side: when this device must offload a prompt, WHICH mesh's peer answers it — the
 *     hierarchical ladder (try the highest/most-private tier first, fall through only on capacity
 *     AND eligibility), capped by the request's privacy class (§6).
 */
import type { DeviceCapability, Sensitivity, Visibility } from "@mycelium/shared";

// ── PROVIDER side: the union firewall (§4) ──────────────────────────────────────────────────

/**
 * The set of consumer public keys the device-global provider must allow: the UNION, across all
 * meshes, of every live peer's `consumerPublicKey` (excluding this device's own caps and any
 * locally-tombstoned peers). One provider, one allow-list = ∪ of the meshes' paired consumers.
 * A broadcast-only public mesh contributes nothing here (its caps carry no provider role), which
 * is exactly why it can never make the provider serve a stranger.
 */
export function unionAllowedConsumers(
  meshCaps: DeviceCapability[][],
  selfKey: string,
  isForgotten: (deviceId: string) => boolean = () => false,
): Set<string> {
  const out = new Set<string>();
  for (const caps of meshCaps) {
    for (const c of caps) {
      if (isForgotten(c.deviceId)) continue;
      if (c.providerPublicKey === selfKey) continue; // never allow-list ourselves
      if (c.consumerPublicKey) out.add(c.consumerPublicKey);
    }
  }
  return out;
}

// ── CONSUMER side: the delegation ladder + eligibility cap (§6) ──────────────────────────────

/** A delegated target in one mesh (warm for unpaid peers; on-demand for paid peers). */
export interface WarmTarget {
  peerKey: string;
  /** Provider load — lower is preferred when two meshes are at the same tier. */
  inflight: number;
  /** Present when the target is already registered and warm on the consumer. */
  modelId?: string;
  /** Resolved alias target for on-demand delegate registration. */
  modelSrc?: string;
  /** Paid peers require a verified session grant before delegate registration. */
  requiresSession?: boolean;
}

/** One mesh as a delegation candidate: its tier/visibility plus its available peer for the alias (if any). */
export interface MeshCandidate {
  meshId: string;
  /** Lower = tried first (private/local home = 0). */
  tier: number;
  visibility: Visibility;
  /** A routable peer for the requested alias in THIS mesh, or undefined if none is ready. */
  warm?: WarmTarget;
}

/** A request to offload: an alias to serve, plus the eligibility inputs (all optional, fail-closed). */
export interface DelegationRequest {
  alias: string;
  /** Privacy class. Default `private` (fail-closed): you opt IN to going wider, never out. */
  sensitivity?: Sensitivity;
  /** Hard pin to a single mesh — never fall through, regardless of tier (the §12 acceptance gate). */
  pinMeshId?: string;
  /** Do not escalate past this tier (a coarser cap than a hard pin). */
  maxTier?: number;
}

export interface RouteHit {
  meshId: string;
  peerKey: string;
  modelId?: string;
  modelSrc?: string;
  requiresSession?: boolean;
}
export interface RouteMiss {
  /** Why nothing was selected — distinguishes "policy excluded every mesh" from "none warm". */
  reason: "no-eligible-mesh" | "no-warm-peer";
}
export type RouteResult = RouteHit | RouteMiss;
export const isRouteHit = (r: RouteResult): r is RouteHit => "meshId" in r;

const visRank = (v: Visibility): number => (v === "private" ? 0 : 1);

/** The widest mesh visibility a request of this class may use. `private` → private only. */
export function maxVisibilityFor(sensitivity: Sensitivity): Visibility {
  return sensitivity === "shareable" ? "public" : "private";
}

/** Is `mesh` eligible for `req`? Honors the hard pin, the tier cap, and the sensitivity→visibility cap. */
export function meshEligible(req: DelegationRequest, mesh: Pick<MeshCandidate, "meshId" | "tier" | "visibility">): boolean {
  if (req.pinMeshId !== undefined) return mesh.meshId === req.pinMeshId;
  if (req.maxTier !== undefined && mesh.tier > req.maxTier) return false;
  return visRank(mesh.visibility) <= visRank(maxVisibilityFor(req.sensitivity ?? "private"));
}

/**
 * The delegation ladder: among the meshes ELIGIBLE for this request, walk them by tier
 * (ascending — home first), and within a tier prefer the lower-inflight peer; return the first
 * eligible mesh that has a warm peer for the alias. Never crosses the eligibility cap: if no
 * eligible mesh can serve, it MISSES (the caller keeps the work local — it never leaks to buy
 * capacity).
 */
export function routeDelegation(req: DelegationRequest, candidates: MeshCandidate[]): RouteResult {
  const eligible = candidates.filter((c) => meshEligible(req, c));
  if (eligible.length === 0) return { reason: "no-eligible-mesh" };
  const ordered = [...eligible].sort((a, b) => a.tier - b.tier || (a.warm?.inflight ?? Infinity) - (b.warm?.inflight ?? Infinity));
  for (const c of ordered) {
    if (c.warm) {
      return {
        meshId: c.meshId,
        peerKey: c.warm.peerKey,
        ...(c.warm.modelId ? { modelId: c.warm.modelId } : {}),
        ...(c.warm.modelSrc ? { modelSrc: c.warm.modelSrc } : {}),
        ...(c.warm.requiresSession ? { requiresSession: true } : {}),
      };
    }
  }
  return { reason: "no-warm-peer" };
}
