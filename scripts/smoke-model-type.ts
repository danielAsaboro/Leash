/**
 * Pure-logic smoke for the mesh model-type classifier (apps/hypha/src/model-type.ts) — the SP2
 * advertisement core. Proves classification of the six real serve entries (chat / vision /
 * embedding / stt / tts), the projection-beats-chat precedence, a catalog MISS falling back to the
 * model name (parakeet is absent from the cached catalog), and the borrowable set (chat+vision only).
 *   npm run smoke:model-type
 */
import assert from "node:assert/strict";
import { modelType, isBorrowable } from "../apps/hypha/src/model-type.ts";

// chat — registry LLM (qwen3-4b)
assert.equal(modelType({ model: "QWEN3_4B_INST_Q4_K_M" }, { endpointCategory: "chat", addon: "llm", engine: "llamacpp-completion" }), "chat");
// chat — custom-GGUF completion with no catalog entry (medpsy)
assert.equal(modelType({ src: "/x/medpsy.gguf", type: "llamacpp-completion" }, undefined), "chat");
// vision — projectionModelSrc wins even though the catalog says endpointCategory "chat" (qwen3vl)
assert.equal(modelType({ model: "QWEN3VL_2B_MULTIMODAL_Q4_K", config: { projectionModelSrc: "/x/mmproj.gguf" } }, { endpointCategory: "chat", addon: "llm", engine: "llamacpp-completion" }), "vision");
// embedding — gte-large
assert.equal(modelType({ model: "GTE_LARGE_FP16" }, { endpointCategory: "embedding", addon: "embeddings", engine: "llamacpp-embedding" }), "embedding");
// tts — supertonic (catalog: endpointCategory "speech", addon "tts")
assert.equal(modelType({ model: "TTS_EN_SUPERTONIC_Q8_0" }, { endpointCategory: "speech", addon: "tts", engine: "tts-ggml" }), "tts");
// stt — parakeet is ABSENT from the cached catalog → name fallback
assert.equal(modelType({ model: "PARAKEET_TDT_0_6B_V3_Q8_0" }, undefined), "stt");
// stt — whisper name fallback
assert.equal(modelType({ model: "WHISPER_BASE_Q8_0" }, undefined), "stt");
// unknown → null (skipped from advertisement)
assert.equal(modelType({ model: "SOMETHING_WEIRD_V2" }, undefined), null);

// borrowable = every real modality: chat delegates directly; vision/embeddings/STT/TTS borrow over the
// P2P forward transport (the provider runs them on its local serve). Only null (unclassified) is not.
assert.equal(isBorrowable("chat"), true);
assert.equal(isBorrowable("vision"), true);
assert.equal(isBorrowable("embedding"), true);
assert.equal(isBorrowable("stt"), true);
assert.equal(isBorrowable("tts"), true);
assert.equal(isBorrowable(null), false);

console.log("✅ model-type — chat/vision/embedding/stt/tts · projection-beats-chat · catalog-miss name fallback · borrowable=all-modalities — GO");
