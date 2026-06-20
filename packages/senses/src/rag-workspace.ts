import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  embed,
  ragChunk,
  ragCloseWorkspace,
  ragDeleteEmbeddings,
  ragDeleteWorkspace,
  ragListWorkspaces,
  ragReindex,
  ragSaveEmbeddings,
  ragSearch,
} from "@qvac/sdk";
import { now, type AuditLog } from "@mycelium/shared";
import { GTE_LARGE_FP16 } from "./models.ts";

interface RagDoc {
  id: string;
  content: string;
}

interface RagSearchResult {
  id: string;
  content: string;
  score: number;
}

export const DEFAULT_RAG_CHUNK_POLICY = {
  chunkSize: 160,
  chunkOverlap: 24,
  chunkStrategy: "paragraph",
  splitStrategy: "token",
} as const;

export interface RagSourceDoc {
  sourceId: string;
  source: string;
  kind: string;
  content: string;
  updatedAt?: string;
  corpusFingerprint?: string;
  textHash?: string;
}

export interface RagManifestChunk {
  chunkId: string;
  content: string;
  textHash: string;
}

export interface RagManifestSource {
  sourceId: string;
  source: string;
  kind: string;
  textHash: string;
  corpusFingerprint?: string;
  updatedAt?: string;
  chunks: RagManifestChunk[];
}

export interface RagWorkspaceManifest {
  version: 1;
  workspace?: string;
  chunkPolicy: typeof DEFAULT_RAG_CHUNK_POLICY;
  sources: Record<string, RagManifestSource>;
  chunks: Record<string, { sourceId: string; source: string; kind: string; textHash: string }>;
}

export interface RagWorkspaceOps {
  ragChunk: typeof ragChunk;
  embed: typeof embed;
  ragSaveEmbeddings: typeof ragSaveEmbeddings;
  ragSearch: typeof ragSearch;
  ragDeleteEmbeddings: typeof ragDeleteEmbeddings;
  ragReindex: typeof ragReindex;
  ragListWorkspaces: typeof ragListWorkspaces;
  ragCloseWorkspace: typeof ragCloseWorkspace;
  ragDeleteWorkspace: typeof ragDeleteWorkspace;
}

const defaultOps: RagWorkspaceOps = {
  ragChunk,
  embed,
  ragSaveEmbeddings,
  ragSearch,
  ragDeleteEmbeddings,
  ragReindex,
  ragListWorkspaces,
  ragCloseWorkspace,
  ragDeleteWorkspace,
};

export interface RagSyncCounts {
  added: number;
  changed: number;
  deleted: number;
  unchanged: number;
  chunksSaved: number;
  chunksDeleted: number;
  reindexed: boolean;
}

export interface RagHit {
  id?: string;
  content: string;
  score: number;
  sourceId?: string;
  source?: string;
  kind?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeIdPart(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || sha256(text).slice(0, 16);
}

function newManifest(workspace?: string): RagWorkspaceManifest {
  return { version: 1, workspace, chunkPolicy: DEFAULT_RAG_CHUNK_POLICY, sources: {}, chunks: {} };
}

export function defaultRagManifestPath(workspace: string): string {
  return join(process.cwd(), "data", "rag", `${safeIdPart(workspace)}.manifest.json`);
}

export function loadRagManifest(file: string, workspace?: string): RagWorkspaceManifest {
  if (!existsSync(file)) return newManifest(workspace);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as RagWorkspaceManifest;
    return {
      ...newManifest(workspace),
      ...parsed,
      sources: parsed.sources ?? {},
      chunks: parsed.chunks ?? {},
    };
  } catch {
    return newManifest(workspace);
  }
}

export function saveRagManifest(file: string, manifest: RagWorkspaceManifest): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function sourceFingerprint(doc: RagSourceDoc): string {
  return doc.corpusFingerprint ?? doc.updatedAt ?? doc.textHash ?? sha256(doc.content);
}

function normalizeEmbedding(embedding: number[] | number[][], count: number): number[][] {
  if (count === 1 && typeof embedding[0] === "number") return [embedding as number[]];
  return embedding as number[][];
}

async function deleteChunks(workspace: string, ids: string[], ops: RagWorkspaceOps): Promise<void> {
  if (ids.length === 0) return;
  await ops.ragDeleteEmbeddings({ workspace, ids });
}

export async function syncRagWorkspace({
  embModelId,
  workspace,
  manifestPath = defaultRagManifestPath(workspace),
  docs,
  ops = defaultOps,
  audit,
  reindexThreshold = 64,
}: {
  embModelId: string;
  workspace: string;
  manifestPath?: string;
  docs: RagSourceDoc[];
  ops?: RagWorkspaceOps;
  audit?: AuditLog;
  reindexThreshold?: number;
}): Promise<RagSyncCounts> {
  const t = now();
  const manifest = loadRagManifest(manifestPath, workspace);
  manifest.workspace = workspace;
  manifest.chunkPolicy = DEFAULT_RAG_CHUNK_POLICY;

  const incoming = new Map(docs.map((doc) => [doc.sourceId, doc]));
  const counts: RagSyncCounts = { added: 0, changed: 0, deleted: 0, unchanged: 0, chunksSaved: 0, chunksDeleted: 0, reindexed: false };

  const staleIds: string[] = [];
  for (const [sourceId, existing] of Object.entries(manifest.sources)) {
    if (!incoming.has(sourceId)) {
      staleIds.push(...existing.chunks.map((c) => c.chunkId));
      delete manifest.sources[sourceId];
      counts.deleted++;
    }
  }

  const toIndex: RagSourceDoc[] = [];
  for (const doc of docs) {
    const textHash = doc.textHash ?? sha256(doc.content);
    const existing = manifest.sources[doc.sourceId];
    if (existing && existing.textHash === textHash && existing.corpusFingerprint === sourceFingerprint(doc)) {
      counts.unchanged++;
      continue;
    }
    if (existing) {
      staleIds.push(...existing.chunks.map((c) => c.chunkId));
      counts.changed++;
    } else {
      counts.added++;
    }
    toIndex.push({ ...doc, textHash });
  }

  if (staleIds.length > 0) {
    await deleteChunks(workspace, staleIds, ops);
    counts.chunksDeleted = staleIds.length;
    for (const id of staleIds) delete manifest.chunks[id];
  }

  for (const doc of toIndex) {
    const textHash = doc.textHash ?? sha256(doc.content);
    const chunks = await ops.ragChunk({ documents: doc.content, chunkOpts: DEFAULT_RAG_CHUNK_POLICY });
    const kept = (chunks as RagDoc[]).filter((chunk: RagDoc) => chunk.content.trim().length > 0);
    const texts = kept.map((chunk: RagDoc) => chunk.content);
    const embeddings = texts.length
      ? normalizeEmbedding((await ops.embed({ modelId: embModelId, text: texts })).embedding, texts.length)
      : [];
    const manifestChunks = kept.map((chunk: RagDoc, index: number) => {
      const chunkHash = sha256(chunk.content);
      return {
        chunkId: `${safeIdPart(doc.sourceId)}:${index}:${chunkHash.slice(0, 16)}`,
        content: chunk.content,
        textHash: chunkHash,
      };
    });
    if (manifestChunks.length > 0) {
      await ops.ragSaveEmbeddings({
        workspace,
        documents: manifestChunks.map((chunk: RagManifestChunk, index: number) => ({
          id: chunk.chunkId,
          content: chunk.content,
          embedding: embeddings[index] as number[],
          embeddingModelId: embModelId,
          metadata: {
            sourceId: doc.sourceId,
            source: doc.source,
            kind: doc.kind,
            textHash,
            corpusFingerprint: sourceFingerprint(doc),
            updatedAt: doc.updatedAt,
          },
        })),
      });
      counts.chunksSaved += manifestChunks.length;
    }
    manifest.sources[doc.sourceId] = {
      sourceId: doc.sourceId,
      source: doc.source,
      kind: doc.kind,
      textHash,
      corpusFingerprint: sourceFingerprint(doc),
      updatedAt: doc.updatedAt,
      chunks: manifestChunks,
    };
    for (const [id, meta] of Object.entries(manifest.chunks)) {
      if (meta.sourceId === doc.sourceId) delete manifest.chunks[id];
    }
    for (const chunk of manifestChunks) {
      manifest.chunks[chunk.chunkId] = { sourceId: doc.sourceId, source: doc.source, kind: doc.kind, textHash: chunk.textHash };
    }
  }

  const churn = counts.chunksSaved + counts.chunksDeleted;
  if (churn >= reindexThreshold) {
    try {
      const result = await ops.ragReindex({ workspace });
      counts.reindexed = Boolean(result.reindexed);
    } catch (error) {
      audit?.record({ event: "note", extra: { role: "rag_maintenance", workspace, error: String(error) } });
    }
  }

  saveRagManifest(manifestPath, manifest);
  audit?.record({
    event: "rag_ingest",
    modelSrc: GTE_LARGE_FP16,
    modelId: embModelId,
    tokens: counts.chunksSaved,
    durationMs: now() - t,
    extra: { workspace, ...counts },
  });
  return counts;
}

export async function searchRagWorkspace({
  embModelId,
  workspace,
  manifestPath = defaultRagManifestPath(workspace),
  query,
  topK = 3,
  ops = defaultOps,
  audit,
}: {
  embModelId: string;
  workspace: string;
  manifestPath?: string;
  query: string;
  topK?: number;
  ops?: RagWorkspaceOps;
  audit?: AuditLog;
}): Promise<RagHit[]> {
  const t = now();
  const manifest = loadRagManifest(manifestPath, workspace);
  const hits = await ops.ragSearch({ modelId: embModelId, workspace, query, topK });
  const enriched = (hits as RagSearchResult[]).map((hit: RagSearchResult) => {
    const meta = manifest.chunks[hit.id];
    return { ...hit, ...(meta ?? {}) };
  });
  audit?.record({
    event: "rag_search",
    modelSrc: GTE_LARGE_FP16,
    modelId: embModelId,
    durationMs: now() - t,
    extra: { workspace, topK, returned: enriched.length, topScore: enriched[0]?.score ?? null },
  });
  return enriched;
}

export async function maintainRagWorkspace({
  workspace,
  ops = defaultOps,
  reindex = false,
  close = false,
  deleteWorkspace = false,
  audit,
}: {
  workspace: string;
  ops?: RagWorkspaceOps;
  reindex?: boolean;
  close?: boolean;
  deleteWorkspace?: boolean;
  audit?: AuditLog;
}) {
  try {
    const result: { workspaces?: Awaited<ReturnType<typeof ragListWorkspaces>>; reindex?: Awaited<ReturnType<typeof ragReindex>> } = {};
    if (reindex) result.reindex = await ops.ragReindex({ workspace });
    result.workspaces = await ops.ragListWorkspaces();
    if (close) await ops.ragCloseWorkspace({ workspace });
    if (deleteWorkspace) await ops.ragDeleteWorkspace({ workspace });
    return result;
  } catch (error) {
    audit?.record({ event: "note", extra: { role: "rag_maintenance", workspace, error: String(error) } });
    throw error;
  }
}
