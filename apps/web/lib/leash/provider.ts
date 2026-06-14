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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createQvac } from "@qvac/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel, type LanguageModelV2Middleware } from "ai";
import { Agent, fetch as undiciFetch } from "undici";
import { loopDiagnosticMiddleware, loopDebugOn } from "./loop-diagnostics.ts";

/**
 * Compose the standard chat middleware: reasoning-extraction (always), and — only when
 * LEASH_DEBUG_LOOP is set — the multi-step loop diagnostic OUTERMOST, so it observes the
 * per-step finishReason / tool-call presence the loop actually sees (after `<think>` is
 * split out). Zero behavior change; pure observation. `label` tags the log line.
 */
function chatMiddleware(label: string): LanguageModelV2Middleware[] {
  const reasoning = extractReasoningMiddleware({ tagName: "think" });
  return loopDebugOn() ? [loopDiagnosticMiddleware(label), reasoning] : [reasoning];
}

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

/** Served model aliases — must match keys in `qvac.config.base.json` → `serve.models`. */
export const CHAT_MODEL = process.env["LEASH_CHAT_MODEL"] ?? "qwen3-4b";
export const EMBED_MODEL = process.env["LEASH_EMBED_MODEL"] ?? "gte-large";
/** QVAC's own medical/healthcare specialist (qvac/MedPsy, a Qwen3 fine-tune). */
export const MEDPSY_MODEL = process.env["LEASH_MEDPSY_MODEL"] ?? "medpsy";
/** Vision-language model (Qwen3VL) for image turns — via the forked serve's image-content support. */
export const VISION_MODEL = process.env["LEASH_VISION_MODEL"] ?? "qwen3vl";
/**
 * Computer-use driver alias — DEFAULTS TO THE CHAT MODEL, so the computer-turn routing
 * is a no-op until configured. Set to a bigger served alias (e.g. `gpt-oss-20b`) for
 * stronger GUI control: served locally, or warm on a paired peer with `QVAC_OPENAI_URL`
 * pointed at the broker (:11436) — the broker availability-routes the turn over the mesh.
 */
export const COMPUTER_MODEL = process.env["LEASH_COMPUTER_MODEL"] ?? CHAT_MODEL;

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

/** The base.json the serve loads (the .mjs wrapper's data file), beside QVAC_CONFIG_PATH (the wrapper). */
const CFG_FILE = process.env["QVAC_CONFIG_PATH"] ? join(dirname(process.env["QVAC_CONFIG_PATH"]), "qvac.config.base.json") : null;

/**
 * The chat alias the user ACTUALLY has configured — the model with `default: true`, else the first
 * configured model, else the built-in CHAT_MODEL. Read per call (the config is tiny) so adding a
 * model in the dashboard makes chat use it on the next turn. Without this, chat asked for a fixed
 * "qwen3-4b" and broke whenever the user loaded a differently-named model.
 */
export function resolvedChatAlias(): string {
  if (process.env["LEASH_CHAT_MODEL"]) return process.env["LEASH_CHAT_MODEL"] as string;
  if (CFG_FILE) {
    try {
      const cfg = JSON.parse(readFileSync(CFG_FILE, "utf8")) as { serve?: { models?: Record<string, { default?: boolean } | string> } };
      const models = cfg.serve?.models ?? {};
      const keys = Object.keys(models);
      const def = keys.find((k) => typeof models[k] === "object" && (models[k] as { default?: boolean }).default);
      return def ?? keys[0] ?? CHAT_MODEL;
    } catch {
      /* fall through */
    }
  }
  return CHAT_MODEL;
}

/** The chat model with `<think>` reasoning extracted into reasoning parts.
 *  `label` tags the loop-diagnostic log line (LEASH_DEBUG_LOOP) so the main chat loop and a
 *  run_skill sub-agent are distinguishable in a multi-step transcript. Defaults to "chat". */
export function chatModel(label = "chat", alias?: string): LanguageModel {
  return wrapLanguageModel({
    model: qvac(alias || resolvedChatAlias()),
    middleware: chatMiddleware(label),
  });
}

/** The chat model tagged BACKGROUND priority (compaction, summaries) — yields to interactive. */
export function chatModelBackground(): LanguageModel {
  return wrapLanguageModel({
    model: qvacBackground(process.env["LEASH_UTILITY_MODEL"] ?? resolvedChatAlias()),
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

/** The computer-use driver — orchestrates the computer tools (the screenshot tool's VLM perceives). */
export function computerModel(): LanguageModel {
  return wrapLanguageModel({
    model: qvac(process.env["LEASH_COMPUTER_MODEL"] ?? resolvedChatAlias()),
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

/** Served image model alias (must match `qvac.config.base.json` → `serve.models`). */
export const IMAGE_MODEL = process.env["LEASH_IMAGE_MODEL"] ?? "sd";

/** The on-device diffusion model for the `generate_image` tool. */
export function imageModel() {
  return qvac.imageModel(IMAGE_MODEL);
}
