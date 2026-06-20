/**
 * Incremental embedding (Layer 2 — Senses).
 *
 * Live CRDT sync means reconciling the durable graph view with the local QVAC RAG
 * workspace. The manifest-backed sync detects added, changed, deleted, and
 * unchanged source docs, deletes stale chunk ids, then embeds only current deltas.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphNode, AuditLog } from "@mycelium/shared";
import { defaultRagManifestPath, syncRagWorkspace } from "./rag-workspace.ts";

export interface EmbedDeltaParams {
  embModelId: string;
  workspace: string;
  nodes: GraphNode[];
  /** Mutated in place: ids already embedded into the workspace. */
  embedded: Set<string>;
  audit?: AuditLog;
}

/** Sync graph nodes into the RAG workspace. Mutates `embedded` for legacy diagnostics. */
export async function embedDelta({ embModelId, workspace, nodes, embedded, audit }: EmbedDeltaParams): Promise<{ added: number; skipped: number; total: number }> {
  const result = await syncRagWorkspace({
    embModelId,
    workspace,
    manifestPath: defaultRagManifestPath(workspace),
    docs: nodes.map((node) => ({
      sourceId: node.id,
      source: node.source,
      kind: node.kind,
      content: node.text,
      updatedAt: node.ts,
      corpusFingerprint: node.meta ? JSON.stringify(node.meta) : node.ts,
    })),
    audit,
  });
  embedded.clear();
  for (const node of nodes) embedded.add(node.id);
  audit?.record({
    event: "graph_sync",
    extra: {
      added: result.added + result.changed,
      skipped: result.unchanged,
      deleted: result.deleted,
      total: nodes.length,
      direction: "replicated",
    },
  });
  return { added: result.added + result.changed, skipped: result.unchanged, total: nodes.length };
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
