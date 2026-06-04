/**
 * The on-device QVAC model, wired into the Vercel AI SDK (server-only).
 *
 * `@qvac/ai-sdk-provider` exposes a *local* OpenAI-compatible endpoint (served by
 * `qvac serve openai`, default :11435) as AI SDK models. So inference stays 100%
 * on-device through QVAC — the hackathon "no cloud AI" rule holds — while we get the
 * AI SDK's streaming, tool-calling, and multi-step loop for free. The provider is a
 * stateless HTTP client; the model itself is held (preloaded) by the `qvac serve`
 * process, so there's nothing to load/unload here.
 *
 * The chat model is wrapped with `extractReasoningMiddleware` so Qwen3's `<think>…</think>`
 * is split into reasoning parts (rendered in the UI's collapsible Reasoning panel)
 * instead of leaking into the answer text.
 */
import "server-only";
import { createQvac } from "@qvac/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel } from "ai";

/** Where `qvac serve openai` listens. 11435 (not Ollama's 11434). */
export const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";

/** Served model aliases — must match keys in `qvac.config.json` → `serve.models`. */
export const CHAT_MODEL = process.env["LEASH_CHAT_MODEL"] ?? "qwen3-4b";
export const EMBED_MODEL = process.env["LEASH_EMBED_MODEL"] ?? "gte-large";
/** QVAC's own medical/healthcare specialist (qvac/MedPsy, a Qwen3 fine-tune). */
export const MEDPSY_MODEL = process.env["LEASH_MEDPSY_MODEL"] ?? "medpsy";
/** Vision-language model (Qwen3VL) for image turns — via the forked serve's image-content support. */
export const VISION_MODEL = process.env["LEASH_VISION_MODEL"] ?? "qwen3vl";

export const qvac = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac" });

/** The chat model with `<think>` reasoning extracted into reasoning parts. */
export function chatModel(): LanguageModel {
  return wrapLanguageModel({
    model: qvac(CHAT_MODEL),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** The medical specialist (MedPsy) — also a Qwen3 "thinking" model, so split `<think>` too. */
export function medpsyModel(): LanguageModel {
  return wrapLanguageModel({
    model: qvac(MEDPSY_MODEL),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** The vision model (Qwen3VL) — image turns route here (the forked serve maps image parts → attachments). */
export function visionModel(): LanguageModel {
  return wrapLanguageModel({
    model: qvac(VISION_MODEL),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** The embedding model (GTE-large) for `search_graph` retrieval. */
export function embeddingModel() {
  return qvac.textEmbeddingModel(EMBED_MODEL);
}

/** Served image model alias (must match `qvac.config.json` → `serve.models`). */
export const IMAGE_MODEL = process.env["LEASH_IMAGE_MODEL"] ?? "sd";

/** The on-device diffusion model for the `generate_image` tool. */
export function imageModel() {
  return qvac.imageModel(IMAGE_MODEL);
}
