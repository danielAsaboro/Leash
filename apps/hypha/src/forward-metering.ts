// Forward-path billable accounting (SP2 Option B, B4 step 1). Each borrowable modality bills in its
// NATURAL unit (spec §B4): chat/vision per OUTPUT token, embeddings per INPUT token, STT per AUDIO-SECOND,
// TTS per CHARACTER. The provider stamps `billableUsage(...)` into the forward done-frame; the consumer-
// side settlement (a later step) turns (unit × count × price) into a payment. Pure + unit-tested.

export type BillableUnit = "token" | "input-token" | "audio-second" | "character";

export interface ForwardUsage {
  unit: BillableUnit;
  count: number;
}

/** What the provider observed while serving the forwarded request, in whatever form the endpoint yields. */
export interface ForwardResponseInfo {
  /** Output tokens counted off the chat SSE. */
  tokens?: number;
  /** Parsed JSON body (embeddings `usage.prompt_tokens`, transcription `duration`). */
  json?: unknown;
  /** Audio length in seconds the provider derived from the uploaded WAV (STT fallback). */
  durationSeconds?: number;
}

/**
 * Rough input-token count for embeddings when the serve reports `usage.prompt_tokens: 0` (it doesn't
 * count). ~4 chars/token is the standard English heuristic; deterministic, so the consumer can verify the
 * charge. `input` is an OpenAI embeddings input — a string or an array of strings.
 */
export function estimateInputTokens(input: unknown): number {
  const texts = Array.isArray(input) ? input : [input];
  let chars = 0;
  for (const t of texts) if (typeof t === "string") chars += t.length;
  return Math.ceil(chars / 4);
}

/** Duration (seconds) of a PCM WAV by reading its header — `data` chunk size / byteRate. 0 if not a WAV. */
export function wavDurationSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return 0;
  const byteRate = buf.readUInt32LE(28);
  if (byteRate === 0) return 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return size / byteRate;
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  return 0;
}

// Billing normalization. Each natural unit converts to a "billing-token-equivalent" so the forward path
// settles through the SAME economy as delegated chat (amountForTokens + quote/open/close) — no separate
// price protocol. These factors are tunable POLICY (relative cost of a modality vs. a chat token):
const CHARS_PER_TOKEN = 4;          // ~4 chars ≈ 1 token (matches estimateInputTokens)
const TOKENS_PER_AUDIO_SECOND = 50; // a second of STT ≈ 50 tokens of work (≈3000 for a minute)

/** Convert billable usage to billing-token-equivalents for the existing token-priced settlement. */
export function forwardBillingTokens(usage: ForwardUsage): number {
  switch (usage.unit) {
    case "token":
    case "input-token":
      return usage.count;
    case "character":
      return Math.ceil(usage.count / CHARS_PER_TOKEN);
    case "audio-second":
      return usage.count * TOKENS_PER_AUDIO_SECOND;
  }
}

/** Map a forwarded endpoint + its request/response to the billable (unit, count) for that modality. */
export function billableUsage(endpoint: string, requestBody: Record<string, unknown>, resp: ForwardResponseInfo): ForwardUsage {
  if (endpoint.includes("/embeddings")) {
    // The serve reports usage.prompt_tokens=0 in practice (it doesn't count) → estimate from the input.
    const prompt = (resp.json as { usage?: { prompt_tokens?: number } } | undefined)?.usage?.prompt_tokens ?? 0;
    return { unit: "input-token", count: prompt > 0 ? prompt : estimateInputTokens(requestBody["input"]) };
  }
  if (endpoint.includes("/audio/speech")) {
    return { unit: "character", count: String(requestBody["input"] ?? "").length };
  }
  if (endpoint.includes("/audio/transcriptions")) {
    const duration = (resp.json as { duration?: number } | undefined)?.duration;
    const seconds = duration !== undefined ? duration : (resp.durationSeconds ?? 0);
    return { unit: "audio-second", count: Math.ceil(seconds) };
  }
  // chat + vision (and any default) → output tokens.
  return { unit: "token", count: resp.tokens ?? 0 };
}
