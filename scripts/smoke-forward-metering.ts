/**
 * Pure unit smoke for forward-path billable accounting (apps/hypha/src/forward-metering.ts) — B4 step 1.
 *
 * Each borrowable modality bills in its NATURAL unit (spec §B4): chat/vision per output token, embeddings
 * per input token, STT per audio-second, TTS per character. This proves `billableUsage` maps each endpoint
 * to the right (unit, count) from the request + the provider's response, and that `wavDurationSeconds`
 * reads a real WAV header. The provider stamps this into the forward done-frame; settlement consumes it.
 *
 *   npm run smoke:forward-metering
 */
import assert from "node:assert/strict";
import { billableUsage, wavDurationSeconds, estimateInputTokens, forwardBillingTokens } from "../apps/hypha/src/forward-metering.ts";

function wav(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

function main(): void {
  // chat/vision → output tokens
  assert.deepEqual(billableUsage("/v1/chat/completions", {}, { tokens: 42 }), { unit: "token", count: 42 }, "chat bills output tokens");

  // embeddings → input tokens (from the serve's usage.prompt_tokens when it actually counts)
  assert.deepEqual(
    billableUsage("/v1/embeddings", { input: "hello" }, { json: { usage: { prompt_tokens: 7 } } }),
    { unit: "input-token", count: 7 },
    "embeddings bill input tokens",
  );

  // REAL-SERVE case: the serve returns usage.prompt_tokens=0 (it doesn't count) → estimate from input (~4 chars/token)
  assert.deepEqual(
    billableUsage("/v1/embeddings", { input: "the quick brown fox jumps" }, { json: { usage: { prompt_tokens: 0, total_tokens: 0 } } }),
    { unit: "input-token", count: 7 }, // 25 chars → ceil(25/4)
    "embeddings fall back to an input-token estimate when the serve reports 0",
  );
  assert.equal(estimateInputTokens(["abcd", "efgh"]), 2, "estimateInputTokens sums array-input chars / 4");
  assert.equal(estimateInputTokens(undefined), 0, "no input → 0 tokens");

  // TTS → characters of the input text (a request-side count)
  assert.deepEqual(
    billableUsage("/v1/audio/speech", { input: "twelve chars" }, {}),
    { unit: "character", count: 12 },
    "speech bills input characters",
  );

  // STT (verbose_json) → audio-seconds from the response duration (rounded up)
  assert.deepEqual(
    billableUsage("/v1/audio/transcriptions", {}, { json: { duration: 12.3 } }),
    { unit: "audio-second", count: 13 },
    "transcription bills audio-seconds from response duration",
  );

  // STT (plain) → audio-seconds derived from the WAV the provider rebuilt
  const oneSecond = wav(16000, 1, 16, 16000 * 2); // 16kHz mono 16-bit, 1s of data
  assert.equal(wavDurationSeconds(oneSecond), 1, "wavDurationSeconds reads a 1s WAV");
  assert.deepEqual(
    billableUsage("/v1/audio/transcriptions", {}, { durationSeconds: wavDurationSeconds(oneSecond) }),
    { unit: "audio-second", count: 1 },
    "transcription falls back to WAV-derived seconds",
  );

  // non-WAV / garbage → 0 seconds (honest: unmetered rather than wrong)
  assert.equal(wavDurationSeconds(Buffer.from("not a wav")), 0, "non-WAV → 0s");

  // forwardBillingTokens — normalize each natural unit to billing-token-equivalents so the forward path
  // settles through the SAME amountForTokens + quote/open/close as delegated chat.
  assert.equal(forwardBillingTokens({ unit: "token", count: 100 }), 100, "output tokens are 1:1");
  assert.equal(forwardBillingTokens({ unit: "input-token", count: 40 }), 40, "input tokens are 1:1");
  assert.equal(forwardBillingTokens({ unit: "character", count: 40 }), 10, "characters → /4 tokens");
  assert.equal(forwardBillingTokens({ unit: "audio-second", count: 2 }), 100, "audio-seconds → ×50 tokens (policy)");
  assert.equal(forwardBillingTokens({ unit: "token", count: 0 }), 0, "zero usage → zero billing");

  console.log("✅ forward-metering — token / input-token (serve-usage or estimate fallback) / character / audio-second billing + WAV duration — GO");
}

main();
