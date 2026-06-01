/**
 * Vector RAG index over the context graph (Layer 2 — Senses).
 *
 * Wraps the proven `ragIngest` / `ragSearch` pattern from spike/02-rag.ts. The
 * graph's node text is the document set; the QVAC RAG workspace is the vector
 * index. This is the `search_graph` tool's backend (the Mind layer's proposer
 * calls `searchGraph`, which the orchestrator runs here).
 */
import { ragIngest, ragSearch } from "@qvac/sdk";
import { AuditLog, now } from "@mycelium/shared";
import type { GraphNode } from "./graph-store.ts";
import { GTE_LARGE_FP16 } from "./models.ts";

/** A retrieved chunk from the graph: the text and its similarity score. */
export interface Hit {
  /** Chunk id assigned by the RAG workspace. */
  id?: string;
  content: string;
  score: number;
}

export interface IngestNodesParams {
  embModelId: string;
  workspace: string;
  nodes: GraphNode[];
  audit?: AuditLog;
}

/** Embed + index every node's text into the workspace. Returns the chunk count. */
export async function ingestNodes({ embModelId, workspace, nodes, audit }: IngestNodesParams): Promise<number> {
  const documents = nodes.map((n) => n.text);
  const t = now();
  const result = await ragIngest({ modelId: embModelId, workspace, documents, chunk: true });
  const chunks = result.processed.length;
  audit?.record({
    event: "rag_ingest",
    modelSrc: GTE_LARGE_FP16,
    modelId: embModelId,
    tokens: chunks,
    durationMs: now() - t,
    extra: { workspace, nodes: nodes.length },
  });
  return chunks;
}

export interface SearchGraphParams {
  embModelId: string;
  workspace: string;
  query: string;
  topK?: number;
  audit?: AuditLog;
}

/** Retrieve the top-K most relevant chunks for a query. Emits a `rag_search` record. */
export async function searchGraph({ embModelId, workspace, query, topK = 3, audit }: SearchGraphParams): Promise<Hit[]> {
  const t = now();
  const hits = (await ragSearch({ modelId: embModelId, workspace, query, topK })) as Hit[];
  audit?.record({
    event: "rag_search",
    modelSrc: GTE_LARGE_FP16,
    modelId: embModelId,
    durationMs: now() - t,
    extra: { workspace, query, topK, scores: hits.map((h) => h.score) },
  });
  return hits;
}
