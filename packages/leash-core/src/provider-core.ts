/**
 * Minimal QVAC model provider for the shared core — JUST the embedding + image models the
 * tool impls need (graph RAG retrieval, `generate_image`). The web process keeps its own
 * full `provider.ts` (chat/vision/medpsy/computer models + reasoning & loop-diagnostic
 * middleware) UNTOUCHED — this is deliberately a separate, dependency-light client so
 * moving `graph.ts` into the package never drags the whole model stack with it.
 *
 * Same on-device guarantee: `@qvac/ai-sdk-provider` is a stateless HTTP client for
 * `qvac serve openai` (:11435) — inference stays 100% on-device (the "no cloud AI" rule).
 */
import { createQvac } from "@qvac/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel } from "ai";
import { Agent, fetch as undiciFetch } from "undici";

/** Where `qvac serve openai` listens. 11435 (not Ollama's 11434). */
export const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
/** Embedding alias — must match `qvac.config.base.json` → `serve.models`. */
export const EMBED_MODEL = process.env["LEASH_EMBED_MODEL"] ?? "embed";
/** Served image model alias. */
export const IMAGE_MODEL = process.env["LEASH_IMAGE_MODEL"] ?? "sd";
/** Vision-language model alias (Qwen3VL), kept for shared-core callers that need image perception. */
export const VISION_MODEL = process.env["LEASH_VISION_MODEL"] ?? "vision";

/**
 * A fetch with NO body/headers timeout for the serve: on-device decodes/embeds can wait
 * legitimately (single slot, broker queue) and undici's default ~300s timeouts would 500
 * those spuriously. Connect timeout stays short so a truly-down serve fails fast.
 */
const patientDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 });
const patientFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
  undiciFetch(input, { ...init, dispatcher: patientDispatcher })) as unknown as typeof fetch;

const qvacInline = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: patientFetch, headers: { "x-leash-priority": "inline" } });
const qvac = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: patientFetch, headers: { "x-leash-priority": "interactive" } });

/** The embedding model for `search_graph` retrieval — tagged INLINE priority. */
export function embeddingModel() {
  return qvacInline.textEmbeddingModel(EMBED_MODEL);
}

/** The on-device diffusion model for the `generate_image` tool. */
export function imageModel() {
  return qvac.imageModel(IMAGE_MODEL);
}

/** The vision model (Qwen3VL) — `<think>` split out like the web's. */
export function visionModel(): LanguageModel {
  return wrapLanguageModel({ model: qvac(VISION_MODEL), middleware: extractReasoningMiddleware({ tagName: "think" }) });
}
