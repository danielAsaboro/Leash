/**
 * Pure model-modality classifier for mesh advertisement (SP2). Maps a `qvac.config.base.json`
 * serve entry (+ its cached-catalog entry, if any) to a modality, and says whether that modality
 * can be BORROWED over the mesh.
 *
 * Borrowability (empirically gated):
 *  - Phase-0 (spike/07): `@qvac/sdk@0.12.1` delegation carries `completion()` only — embed/transcribe/
 *    textToSpeech throw "delegated model … cannot be accessed directly" → embeddings/STT/TTS local-only.
 *  - LIVE two-Mac test (2026-06-11): VISION (qwen3vl) borrows TEXT fine, but IMAGES don't cross — SDK
 *    `attachments` are PATH-only and the path is resolved on the PROVIDER, which can't read the
 *    consumer's image file (the same-machine spike masked this via a shared filesystem). A VLM borrowed
 *    text-only is pointless, so vision is local-only too. → **only CHAT is borrowable cross-mesh.**
 *    (Cross-mesh image transport = a custom serve-proxy, Option B / deferred.)
 *
 * No `@qvac/sdk`, no Node — pure, unit-tested by scripts/smoke-model-type.ts.
 */
export type Modality = "chat" | "vision" | "embedding" | "stt" | "tts";

export interface ModelTypeEntry {
  model?: string;
  src?: string;
  type?: string;
  config?: Record<string, unknown>;
}
export interface ModelTypeCatalog {
  endpointCategory?: string;
  addon?: string;
  engine?: string;
}

/** Classify a serve entry into a modality, or null (skip from advertisement). */
export function modelType(entry: ModelTypeEntry, cat?: ModelTypeCatalog): Modality | null {
  // A VLM with a projection model (e.g. qwen3vl) is VISION — checked first, since its catalog
  // entry also reads as endpointCategory "chat".
  if (entry.config && "projectionModelSrc" in entry.config) return "vision";
  // Custom-GGUF completion model (e.g. medpsy: a `.src` path with type "…completion", no catalog).
  if (entry.src && (entry.type ?? "").includes("completion")) return "chat";

  const engine = cat?.engine ?? "";
  const ec = cat?.endpointCategory;
  const addon = cat?.addon;
  if (ec === "chat" && (addon === "llm" || engine.startsWith("llamacpp"))) return "chat";
  if (ec === "embedding" || ec === "embeddings" || addon === "embeddings") return "embedding";
  if (ec === "speech" || addon === "tts" || engine.includes("tts")) return "tts";
  if (ec === "transcription" || addon === "parakeet" || addon === "whisper") return "stt";

  // Catalog miss (e.g. parakeet is absent from the cached catalog) → classify by model name.
  const name = (entry.model ?? "").toUpperCase();
  if (/PARAKEET|WHISPER|SORTFORMER/.test(name)) return "stt";
  if (/SUPERTONIC|CHATTERBOX|TTS[_-]|_TTS\b/.test(name)) return "tts";
  if (/GTE[_-]|EMBED|BGE[_-]|\bE5[_-]/.test(name)) return "embedding";
  if (/VL[_-]|VISION|MULTIMODAL|MMPROJ|LLAVA/.test(name)) return "vision";
  if (/QWEN|LLAMA|GEMMA|MISTRAL|PHI|MEDGEMMA/.test(name)) return "chat";
  return null;
}

/** True only for modalities that can be BORROWED over the mesh. Empirically: only CHAT — the SDK
 * delegates `completion()` only, and its multimodal `attachments` are path-only (read on the provider),
 * so a consumer's image can't cross. Vision/embeddings/STT/TTS are advertised display-only. */
export function isBorrowable(m: Modality | null): boolean {
  return m === "chat";
}
