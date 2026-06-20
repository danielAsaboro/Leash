/**
 * Vector RAG index over the context graph (Layer 2 — Senses).
 *
 * Uses the controlled QVAC SDK RAG workflow:
 * ragChunk → embed → ragSaveEmbeddings → ragSearch, with a small local manifest
 * keyed by deterministic chunk id so search results can be resolved back to graph
 * sources.
 */
import type { AuditLog } from "@mycelium/shared";
import type { GraphNode } from "./graph-store.ts";
import { defaultRagManifestPath, searchRagWorkspace, syncRagWorkspace } from "./rag-workspace.ts";

/** A retrieved chunk from the graph: the text and its similarity score. */
export interface Hit {
  /** Chunk id assigned by the RAG workspace. */
  id?: string;
  content: string;
  score: number;
  sourceId?: string;
  source?: string;
  kind?: string;
}

export interface IngestNodesParams {
  embModelId: string;
  workspace: string;
  nodes: GraphNode[];
  manifestPath?: string;
  audit?: AuditLog;
}

/** Embed + index every node's text into the workspace. Returns the chunk count. */
export async function ingestNodes({ embModelId, workspace, nodes, manifestPath = defaultRagManifestPath(workspace), audit }: IngestNodesParams): Promise<number> {
  const result = await syncRagWorkspace({
    embModelId,
    workspace,
    manifestPath,
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
  return result.chunksSaved;
}

export interface SearchGraphParams {
  embModelId: string;
  workspace: string;
  query: string;
  topK?: number;
  manifestPath?: string;
  audit?: AuditLog;
}

/** Retrieve the top-K most relevant chunks for a query. Emits a `rag_search` record. */
export async function searchGraph({ embModelId, workspace, query, topK = 3, manifestPath = defaultRagManifestPath(workspace), audit }: SearchGraphParams): Promise<Hit[]> {
  return searchRagWorkspace({ embModelId, workspace, manifestPath, query, topK, audit });
}
