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
export { MeshGraph } from "./mesh-graph.ts";
export type { MeshGraphOptions, PairOptions } from "./mesh-graph.ts";
