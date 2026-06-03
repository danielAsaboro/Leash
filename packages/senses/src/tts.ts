/**
 * Text-to-speech connector (Layer 2 — Senses).
 *
 * On-device speech synthesis via `@qvac/sdk` `textToSpeech()` + the GGML Supertonic
 * voice (`modelType: "tts"`). Turns an article's prose into a `.wav` the reader can
 * play — fully offline once the model is warm-cached. Mirrors `voice.ts` (the STT
 * direction): a thin load / synthesize / unload trio that records audit timings.
 */
import { writeFileSync } from "node:fs";
import { loadModel, unloadModel, textToSpeech } from "@qvac/sdk";
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";
import { TTS_EN_SUPERTONIC_Q8_0, TTS_SUPERTONIC_SAMPLE_RATE } from "./models.ts";

/** Load the Supertonic TTS model (English, baked-in voices); returns its modelId. */
export async function loadTts(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({
    modelSrc: TTS_EN_SUPERTONIC_Q8_0,
    modelType: "tts",
    modelConfig: { ttsEngine: "supertonic", language: "en", voice: "F1", ttsSpeed: 1.05, ttsNumInferenceSteps: 5 },
    onProgress: () => {},
  } as Parameters<typeof loadModel>[0]);
  audit?.record({ event: "model_load", modelSrc: "TTS_EN_SUPERTONIC_Q8_0", modelId });
  return modelId;
}

/** Unload the TTS model. */
export async function unloadTts(modelId: string, audit?: AuditLog): Promise<void> {
  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelSrc: "TTS_EN_SUPERTONIC_Q8_0", modelId });
}

/** Wrap 16-bit PCM samples (Int16Array) as a minimal mono WAV file buffer. */
function pcmToWav(samples: ArrayLike<number>, sampleRate: number): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

export interface SynthesizeParams {
  ttsModelId: string;
  /** Plain text to read aloud (strip markdown before calling). */
  text: string;
  /** Absolute path of the `.wav` to write. */
  outPath: string;
  audit?: AuditLog;
}

/** Synthesize `text` to a WAV file at `outPath`. Returns the sample count. */
export async function synthesizeToWav({ ttsModelId, text, outPath, audit }: SynthesizeParams): Promise<number> {
  const t = now();
  const result = textToSpeech({ modelId: ttsModelId, text, inputType: "text", stream: false } as Parameters<typeof textToSpeech>[0]);
  const pcm = (await (result as { buffer: Promise<ArrayLike<number>> }).buffer);
  writeFileSync(outPath, pcmToWav(pcm, TTS_SUPERTONIC_SAMPLE_RATE));
  audit?.record({ event: "note", durationMs: now() - t, extra: { role: "tts", outPath, chars: text.length, samples: pcm.length } });
  return pcm.length;
}
