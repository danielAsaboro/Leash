/**
 * The context-graph node type — the unit of perception synced across the mesh.
 *
 * Lives in @mycelium/shared (the dependency-free foundation) so both senses (which
 * embeds nodes) and mesh (which replicates them via Autobase) can use it without a
 * dependency cycle. The shape is mesh-friendly by design: a stable UUID `id` (the
 * Hyperbee view's dedupe key in the replicated CRDT view), an ISO `ts`, and a
 * `source` provenance field.
 */

/** A single perception in the context graph. */
export interface GraphNode {
  /** Stable id (uuid) — the CRDT dedupe key in the replicated view. */
  id: string;
  /** What kind of signal produced this node. */
  kind: "file" | "voice" | "note";
  /** Provenance — file path, audio path, or a free-form origin label. */
  source: string;
  /** The text content that gets embedded + retrieved. */
  text: string;
  /** ISO timestamp the node entered the graph. */
  ts: string;
  /** Free-form structured extras (tags, device, lat/long, …). */
  meta?: Record<string, unknown>;
}

/** Fields a caller supplies; `id` and `ts` are filled in if omitted. */
export type GraphNodeInput = Omit<GraphNode, "id" | "ts"> & { id?: string; ts?: string };
