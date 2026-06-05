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
import { Agent, fetch as undiciFetch } from "undici";

/**
 * A fetch with NO body/headers timeout for the serve. On-device decodes are slow and a
 * request can legitimately wait (behind the broker queue, or for the serve to free its
 * single slot); undici's default ~300s timeouts would 500 those turns spuriously — which
 * is exactly what we kept hitting. The serve never gets a client-abort either (wedge
 * rule); a turn runs to completion or the user navigates away. Headers timeout is the
 * connect, kept short so a truly-down serve still fails fast.
 */
const patientDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 });
const patientFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
  undiciFetch(input, { ...init, dispatcher: patientDispatcher })) as unknown as typeof fetch;

/** Where `qvac serve openai` listens. 11435 (not Ollama's 11434). */
export const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";

/** Served model aliases — must match keys in `qvac.config.json` → `serve.models`. */
export const CHAT_MODEL = process.env["LEASH_CHAT_MODEL"] ?? "qwen3-4b";
export const EMBED_MODEL = process.env["LEASH_EMBED_MODEL"] ?? "gte-large";
/** QVAC's own medical/healthcare specialist (qvac/MedPsy, a Qwen3 fine-tune). */
export const MEDPSY_MODEL = process.env["LEASH_MEDPSY_MODEL"] ?? "medpsy";
/** Vision-language model (Qwen3VL) for image turns — via the forked serve's image-content support. */
export const VISION_MODEL = process.env["LEASH_VISION_MODEL"] ?? "qwen3vl";

/**
 * Priority-tagged provider instances. The `x-leash-priority` header is consumed by the
 * leash-broker (the queue in front of the serve) to order requests — interactive chat
 * over background maintenance — and is harmless when `QVAC_OPENAI_URL` points straight
 * at the serve (it ignores the header). Background callers should use `qvacBackground`.
 */
export const qvac = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: patientFetch, headers: { "x-leash-priority": "interactive" } });
const qvacInline = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: patientFetch, headers: { "x-leash-priority": "inline" } });
export const qvacBackground = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: patientFetch, headers: { "x-leash-priority": "background" } });

/** Background utility model alias for maintenance work (compaction, etc.). Defaults to
 *  the chat model so nothing changes until the user adds a small reasoning-off alias. */
export const UTILITY_MODEL = process.env["LEASH_UTILITY_MODEL"] ?? CHAT_MODEL;

/** The chat model with `<think>` reasoning extracted into reasoning parts. */
export function chatModel(): LanguageModel {
  return wrapLanguageModel({
    model: qvac(CHAT_MODEL),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** The chat model tagged BACKGROUND priority (compaction, summaries) — yields to interactive. */
export function chatModelBackground(): LanguageModel {
  return wrapLanguageModel({
    model: qvacBackground(UTILITY_MODEL),
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

/** The embedding model (GTE-large) for `search_graph` retrieval — tagged INLINE priority. */
export function embeddingModel() {
  return qvacInline.textEmbeddingModel(EMBED_MODEL);
}

/** Served image model alias (must match `qvac.config.json` → `serve.models`). */
export const IMAGE_MODEL = process.env["LEASH_IMAGE_MODEL"] ?? "sd";

/** The on-device diffusion model for the `generate_image` tool. */
export function imageModel() {
  return qvac.imageModel(IMAGE_MODEL);
}
