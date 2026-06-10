/**
 * @mycelium/mesh — Layer 1 (Mesh): the encrypted P2P fabric that lets a weak
 * device borrow a strong peer's brain. Built on the proven `startQVACProvider` /
 * `loadModel({ delegate })` primitives (de-risked by the Days 1–3 spike).
 *
 * - provider.ts — the hub starts a delegated-inference provider.
 * - consumer.ts — the edge registers a model against the provider; completions run there.
 * - registry.ts — in-memory capability registry + best-provider selection.
 */
export { startProvider } from "./provider.ts";
export type { StartProviderParams } from "./provider.ts";
export { loadDelegated } from "./consumer.ts";
export type { LoadDelegatedParams } from "./consumer.ts";
export { CapabilityRegistry } from "./registry.ts";
export { MeshGraph, unpairKey, verifyAdapterBytes } from "./mesh-graph.ts";
export type { MeshGraphOptions, PairOptions, UnpairRecord, AdapterMeta } from "./mesh-graph.ts";
export { MeshHost, PRIMARY_MESH_ID } from "./mesh-host.ts";
export type { MeshHostOptions, OpenMeshOptions, PairMeshOptions } from "./mesh-host.ts";
export { unionAllowedConsumers, routeDelegation, meshEligible, maxVisibilityFor, isRouteHit } from "./delegation-policy.ts";
export type { MeshCandidate, WarmTarget, DelegationRequest, RouteResult, RouteHit, RouteMiss } from "./delegation-policy.ts";
export { GossipMesh, deriveCellSeed, ephemeralCellId } from "./gossip-mesh.ts";
export type { GossipMessage } from "./gossip-mesh.ts";
export { PublicMesh, cellTopic } from "./public-mesh.ts";
export type { PublicMeshOptions } from "./public-mesh.ts";
export { authorizeBudget, authorizeSettlement, SpendGuard } from "./spend-policy.ts";
export type {
  SpendLimits,
  PriceSheet,
  SettlementRequest,
  BudgetRequest,
  SettlementDecision,
  BudgetDecision,
  BudgetReservation,
  PayFn,
  PayAuthorizedFn,
} from "./spend-policy.ts";
export { liveProviders, startHeartbeat } from "./failover.ts";
export type { LiveProviderOpts, HeartbeatHandle } from "./failover.ts";
export { startAdapterSync, syncAdaptersOnce } from "./adapter-sync.ts";
export type { AdapterSyncHandle, SyncOnceOptions, SyncResult } from "./adapter-sync.ts";
