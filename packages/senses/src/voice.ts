/**
 * Voice connector (Layer 2 — Senses).
 *
 * On-device speech-to-text via the proven `transcribe()` + a `WHISPER_*` model
 * (`modelType: "whisper"`). The caller appends the transcript as a `kind:"voice"`
 * graph node, so spoken memos become retrievable context exactly like files.
 * Fully offline once the whisper model is warm-cached.
 */
import { loadModel, unloadModel, transcribe } from "@qvac/sdk";
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";
import { WHISPER_BASE_Q8_0 } from "./models.ts";

/** Load the whisper STT model; returns its modelId. */
export async function loadWhisper(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({ modelSrc: WHISPER_BASE_Q8_0, modelType: "whisper", onProgress: () => {} });
  audit?.record({ event: "model_load", modelSrc: WHISPER_BASE_Q8_0, modelId });
  return modelId;
}

/** Unload the whisper model. */
export async function unloadWhisper(modelId: string, audit?: AuditLog): Promise<void> {
  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelSrc: WHISPER_BASE_Q8_0, modelId });
}

export interface TranscribeFileParams {
  sttModelId: string;
  /** Path to an audio file (e.g. a .wav). */
  audioPath: string;
  audit?: AuditLog;
}

/** Transcribe an audio file to text. Records a `note` with the timing + length. */
export async function transcribeFile({ sttModelId, audioPath, audit }: TranscribeFileParams): Promise<string> {
  const t = now();
  const text = (await transcribe({ modelId: sttModelId, audioChunk: audioPath })).trim();
  audit?.record({ event: "note", durationMs: now() - t, extra: { role: "transcribe", audioPath, chars: text.length } });
  return text;
}
