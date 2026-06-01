/**
 * On-device embedding model loader (Layer 2 — Senses).
 *
 * Thin wrapper over the proven spike pattern (`loadModel({ GTE_LARGE_FP16,
 * "embeddings" })`). GTE_LARGE_FP16 produces 1024-dim vectors and is the same
 * model the RAG index uses for ingest + search, so embeddings stay consistent.
 */
import { loadModel, unloadModel } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import { GTE_LARGE_FP16 } from "./models.ts";

/** Load the embedding model and return its modelId. Optionally records `model_load`. */
export async function loadEmbeddings(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: "embeddings", onProgress: () => {} });
  audit?.record({ event: "model_load", modelSrc: GTE_LARGE_FP16, modelId });
  return modelId;
}

/** Unload the embedding model. Optionally records `model_unload`. */
export async function unloadEmbeddings(modelId: string, audit?: AuditLog): Promise<void> {
  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelSrc: GTE_LARGE_FP16, modelId });
}
