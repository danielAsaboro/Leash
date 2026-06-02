/**
 * Typed re-exports of the QVAC model constants Mycelium uses.
 *
 * The SDK ships these as runtime exports, but its published root `.d.ts` does NOT
 * surface the LLM/embedding model constants (only the diffusion/upscale ones) — a
 * type-packaging gap in @qvac/sdk@0.11.0 (they live behind a ~16k-line `models`
 * tuple in models.d.ts). A direct `import { GTE_LARGE_FP16 } from "@qvac/sdk"`
 * therefore fails `tsc` even though it resolves at runtime (the spike proves it;
 * `tsx` skips type-checking, so this never surfaced in the spike scripts).
 *
 * We import the runtime values once here and re-export them typed as
 * `LoadModelOptions["modelSrc"]`, so every other layer references models with full
 * type-safety and zero suppression. This is the single seam touching the gap.
 */
import type { LoadModelOptions } from "@qvac/sdk";
// prettier-ignore
// @ts-ignore — present at runtime in @qvac/sdk; absent from its root .d.ts (LLM/embedding/whisper/OCR consts only).
import { GTE_LARGE_FP16 as _GTE_LARGE_FP16, QWEN3_600M_INST_Q4 as _QWEN3_600M_INST_Q4, QWEN3_4B_INST_Q4_K_M as _QWEN3_4B_INST_Q4_K_M, WHISPER_BASE_Q8_0 as _WHISPER_BASE_Q8_0, OCR_LATIN_RECOGNIZER_1 as _OCR_LATIN_RECOGNIZER_1 } from "@qvac/sdk";

export type ModelSrc = LoadModelOptions["modelSrc"];

/** 1024-dim embeddings — used for both ingest and search. */
export const GTE_LARGE_FP16: ModelSrc = _GTE_LARGE_FP16;
/** Trivial/local router model — small, fast, tool-capable; runs on the edge node. */
export const QWEN3_600M_INST_Q4: ModelSrc = _QWEN3_600M_INST_Q4;
/** Council proposer/critic — Mac-class, reliable tool-calling; runs on the hub. */
export const QWEN3_4B_INST_Q4_K_M: ModelSrc = _QWEN3_4B_INST_Q4_K_M;
/** Speech-to-text (voice ingestion); loaded with modelType:"whisper". */
export const WHISPER_BASE_Q8_0: ModelSrc = _WHISPER_BASE_Q8_0;
/** Photo OCR recognizer (Latin/English); loaded with modelType:"ocr". Auto-pairs the
 * CRAFT text detector at load, so only this constant is referenced in code. */
export const OCR_LATIN_RECOGNIZER_1: ModelSrc = _OCR_LATIN_RECOGNIZER_1;
