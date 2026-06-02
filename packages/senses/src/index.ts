/**
 * @mycelium/senses — Layer 2 (Senses): the context graph + its vector RAG index.
 *
 * Local-first for the Week-1 slice: an append-only JSONL node store + the proven
 * QVAC RAG workspace as the vector index. Voice ingestion (whisper STT) lands in
 * voice.ts as the final slice step; Hypercore/Autobase P2P sync is Week-2.
 */
export { GraphStore } from "./graph-store.ts";
export type { GraphNode, GraphNodeInput } from "@mycelium/shared";
export { loadEmbeddings, unloadEmbeddings } from "./embeddings.ts";
export { ingestNodes, searchGraph } from "./rag-index.ts";
export type { Hit, IngestNodesParams, SearchGraphParams } from "./rag-index.ts";
export { ingestNotesDir, seedFromDataDir } from "./connectors.ts";
export type { IngestNotesDirParams, SeedFromDataDirParams, AppendableGraph } from "./connectors.ts";
export { embedDelta, loadEmbeddedIds, saveEmbeddedIds } from "./incremental.ts";
export type { EmbedDeltaParams } from "./incremental.ts";
export { loadWhisper, unloadWhisper, transcribeFile } from "./voice.ts";
export type { TranscribeFileParams } from "./voice.ts";
export { loadOcr, unloadOcr, ocrFile } from "./photo.ts";
export type { OcrFileParams } from "./photo.ts";
export { WHISPER_BASE_Q8_0 } from "./models.ts";
// Typed model constants (works around the SDK's root-.d.ts gap; see models.ts).
export { GTE_LARGE_FP16, QWEN3_600M_INST_Q4, QWEN3_4B_INST_Q4_K_M, OCR_LATIN_RECOGNIZER_1 } from "./models.ts";
export type { ModelSrc } from "./models.ts";
