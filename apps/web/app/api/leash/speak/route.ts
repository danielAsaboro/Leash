/**
 * `POST /api/leash/speak` — on-device "read aloud" for an assistant answer.
 *
 * Relays text to the local `qvac serve openai` speech endpoint (`tts`, served
 * from `qvac.config.base.json`) and streams the WAV straight back to the browser. Pure HTTP,
 * on-device, no `@qvac/sdk` in Next — same pattern as the chat route.
 *
 * On failure we return a structured `{ error, code }` JSON (not a generic 502) so the UI
 * can surface an honest, actionable message: `offline` (serve down), `model_not_found`
 * (TTS voice model not registered/loaded), or the serve's own message verbatim.
 */
import { stripMarkdownForSpeech } from "../../../../lib/leash/speech-text.ts";
import { beginGeneration } from "../../../../lib/leash/inflight.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const TTS_MODEL = process.env["LEASH_TTS_MODEL"] ?? "tts";

// Allowlists so an arbitrary client value can't be relayed to the serve. Keep in sync with
// `lib/leash/audio.ts` VOICES (only verified Supertonic voices) — no fake voices (hard rule #4).
const ALLOWED_VOICES = new Set(["F1"]);
const ALLOWED_MODELS = new Set([TTS_MODEL]);

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function POST(req: Request): Promise<Response> {
  const { text, voice, model } = (await req.json()) as { text?: string; voice?: string; model?: string };
  // Strip markdown defensively for EVERY caller (voice queue + the read-aloud button) so TTS
  // never reads "asterisk"/backticks aloud, even if a caller forgot to clean the text upstream.
  const input = stripMarkdownForSpeech(text ?? "").trim();
  if (!input) return json({ error: "Nothing to read aloud.", code: "empty_input" }, 400);

  // Validate against the allowlists; unknown values fall back to the configured default rather
  // than 400'ing — the serve resolves voices[voice] → `${model}-${voice}` → bare model anyway.
  const ttsModel = model && ALLOWED_MODELS.has(model) ? model : TTS_MODEL;
  const ttsVoice = voice && ALLOWED_VOICES.has(voice) ? voice : undefined;

  let upstream: Response;
  // Count the TTS inference as in-flight (serve stop/restart must not interrupt it). The serve
  // buffers the full WAV before responding, so release-after-fetch covers the whole generation.
  const release = beginGeneration();
  try {
    upstream = await fetch(`${QVAC_OPENAI_URL}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Option B: keep `model: TTS_MODEL`, add `voice` so the serve resolves the voiced alias.
      body: JSON.stringify({ model: ttsModel, input: input.slice(0, 4000), response_format: "wav", ...(ttsVoice ? { voice: ttsVoice } : {}) }),
    });
  } catch {
    // Connection refused / DNS / network: the local serve isn't reachable.
    return json({ error: "The on-device speech service is offline. Start it with `npm run qvac`.", code: "offline" }, 503);
  } finally {
    release();
  }

  if (!upstream.ok || !upstream.body) {
    // Surface the serve's own error (e.g. model_not_found) so the UI message is actionable.
    let detail: { error?: { message?: string; code?: string } } = {};
    try {
      detail = (await upstream.json()) as typeof detail;
    } catch {
      /* non-JSON error body */
    }
    const code = detail.error?.code ?? `http_${upstream.status}`;
    // Concise server-side breadcrumb (no user content) for future TTS triage.
    console.error(`[speak] serve error ${upstream.status} (${code})`);
    const message =
      code === "model_not_found"
        ? `The voice model "${ttsModel}" isn't loaded. Add it to qvac.config.base.json → serve.models and restart \`npm run qvac\`.`
        : detail.error?.message ?? `Speech failed (HTTP ${upstream.status}).`;
    return json({ error: message, code }, 502);
  }

  return new Response(upstream.body, { status: 200, headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}
