/**
 * Incremental embedding (Layer 2 — Senses).
 *
 * Live CRDT sync means embedding only the DELTA — the nodes not yet in the vector
 * workspace — instead of the Week-1 destructive full re-embed. `ragIngest` is
 * append-only to a workspace, so we track embedded node ids and ingest only the new
 * ones. The id set persists to disk so we never re-embed across restarts, keeping
 * the workspace in lockstep with the durable Autobase view.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphNode, AuditLog } from "@mycelium/shared";
import { ingestNodes } from "./rag-index.ts";

export interface EmbedDeltaParams {
  embModelId: string;
  workspace: string;
  nodes: GraphNode[];
  /** Mutated in place: ids already embedded into the workspace. */
  embedded: Set<string>;
  audit?: AuditLog;
}

/** Embed only the nodes whose id ∉ embedded. Mutates `embedded`. Returns counts. */
export async function embedDelta({ embModelId, workspace, nodes, embedded, audit }: EmbedDeltaParams): Promise<{ added: number; skipped: number; total: number }> {
  const fresh = nodes.filter((n) => !embedded.has(n.id));
  if (fresh.length > 0) {
    await ingestNodes({ embModelId, workspace, nodes: fresh, audit });
    for (const n of fresh) embedded.add(n.id);
  }
  audit?.record({ event: "graph_sync", extra: { added: fresh.length, skipped: nodes.length - fresh.length, total: nodes.length, direction: "replicated" } });
  return { added: fresh.length, skipped: nodes.length - fresh.length, total: nodes.length };
}

/** Load the persisted embedded-id set (empty if absent or unreadable). */
export function loadEmbeddedIds(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(file, "utf-8")) as string[]);
  } catch {
    return new Set();
  }
}

/** Persist the embedded-id set (write whole file). */
export function saveEmbeddedIds(file: string, ids: Set<string>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...ids]));
}
