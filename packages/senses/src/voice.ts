/**
 * Voice connector (Layer 2 — Senses).
 *
 * On-device speech-to-text via the proven `transcribe()` + a `WHISPER_*` model
 * (`modelType: "whisper"`). The caller appends the transcript as a `kind:"voice"`
 * graph node, so spoken memos become retrievable context exactly like files.
 * Fully offline once the whisper model is warm-cached.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModel, unloadModel, transcribe } from "@qvac/sdk";
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";
import { WHISPER_BASE_Q8_0, PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0, PARAKEET_TDT_0_6B_V3_Q8_0 } from "./models.ts";

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

// ── 0.12.0: Parakeet diarization (who-spoke-when) ───────────────────────────────
// Two-step flow (per the SDK's `transcription/parakeet-sortformer` example): Sortformer
// diarizes the audio into speaker segments, then TDT transcribes each segment. Both load
// with `modelType:"parakeet"`. Whisper (above) stays the default single-speaker path; the
// diarizer is opt-in behind this seam, so existing callers are unchanged.

/** Load the Sortformer diarization model (who spoke when, ≤4 speakers). */
export async function loadDiarizer(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({ modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0, modelType: "parakeet", onProgress: () => {} } as Parameters<typeof loadModel>[0]);
  audit?.record({ event: "model_load", modelSrc: "PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0", modelId });
  return modelId;
}

/** Load the Parakeet TDT transcription model (transcribes each diarized segment). */
export async function loadTranscriber(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({ modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0, modelType: "parakeet", onProgress: () => {} } as Parameters<typeof loadModel>[0]);
  audit?.record({ event: "model_load", modelSrc: "PARAKEET_TDT_0_6B_V3_Q8_0", modelId });
  return modelId;
}

/** Unload a Parakeet model (diarizer or transcriber). */
export async function unloadParakeet(modelId: string, audit?: AuditLog): Promise<void> {
  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelId });
}

/** One attributed speech span. */
export interface SpeakerSegment {
  speaker: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
}

/** Seconds from a Sortformer timestamp — `HH:MM:SS.mmm` (the 0.12.1 form) or `12.3s`. */
function tsToSeconds(ts: string): number {
  const hms = ts.match(/(\d+):(\d+):([\d.]+)/);
  if (hms) return +hms[1]! * 3600 + +hms[2]! * 60 + +hms[3]!;
  const sec = ts.match(/([\d.]+)/);
  return sec ? +sec[1]! : 0;
}

/**
 * Parse Sortformer output into ordered segments. 0.12.1 emits
 * `Speaker N: HH:MM:SS.mmm - HH:MM:SS.mmm`; we also accept the older `Xs - Ys` form.
 */
function parseDiarization(text: string): Array<{ speaker: number; start: number; end: number }> {
  const segs: Array<{ speaker: number; start: number; end: number }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/Speaker\s+(\d+):\s*([0-9:.]+)\s*-\s*([0-9:.]+)/);
    if (m) segs.push({ speaker: +m[1]!, start: tsToSeconds(m[2]!), end: tsToSeconds(m[3]!) });
  }
  return segs.sort((a, b) => a.start - b.start);
}

/** Read the raw PCM `data` chunk out of a 16 kHz mono WAV. */
function readPcm(wavPath: string): Buffer {
  const buf = readFileSync(wavPath);
  const dataOffset = buf.indexOf("data") + 4;
  return buf.subarray(dataOffset + 4, dataOffset + 4 + buf.readUInt32LE(dataOffset));
}

/** Write a [startSec,endSec) slice of 16 kHz mono PCM as its own WAV. Returns false if empty. */
function writeWavSlice(pcm: Buffer, startSec: number, endSec: number, outPath: string): boolean {
  const SR = 16000;
  const BPS = 2;
  const startByte = Math.floor(startSec * SR) * BPS;
  const endByte = Math.min(Math.ceil(endSec * SR) * BPS, pcm.length);
  if (startByte >= endByte) return false;
  const slice = pcm.subarray(startByte, endByte);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + slice.length, 4);
  hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * BPS, 28);
  hdr.writeUInt16LE(BPS, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(slice.length, 40);
  writeFileSync(outPath, Buffer.concat([hdr, slice]));
  return true;
}

/** Merge consecutive same-speaker segments into single spans. */
function mergeSpeakers(entries: SpeakerSegment[]): SpeakerSegment[] {
  const out: SpeakerSegment[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.speaker === e.speaker) {
      last.text += " " + e.text;
      last.end = e.end;
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

export interface DiarizeFileParams {
  diarizerModelId: string;
  transcriberModelId: string;
  /** Path to a 16 kHz mono WAV. */
  audioPath: string;
  audit?: AuditLog;
}

export interface DiarizeResult {
  /** Speaker-attributed transcript ("Speaker N: …" per merged span) — embed this for RAG. */
  text: string;
  /** Structured segments for `GraphNode.meta` (quote attribution). */
  segments: SpeakerSegment[];
  /** Distinct speaker count. */
  speakers: number;
}

/**
 * Diarize + transcribe an audio file: Sortformer finds speaker turns, TDT transcribes each.
 * Returns a speaker-attributed transcript plus structured segments. Records audit timings.
 */
export async function diarizeFile({ diarizerModelId, transcriberModelId, audioPath, audit }: DiarizeFileParams): Promise<DiarizeResult> {
  const t = now();
  const diar = await transcribe({ modelId: diarizerModelId, audioChunk: audioPath });
  const turns = parseDiarization(diar);
  const pcm = readPcm(audioPath);
  const sliceDir = join(tmpdir(), `mycelium-diarize-${turns.length}-${Math.floor(now())}`);
  mkdirSync(sliceDir, { recursive: true });

  const segments: SpeakerSegment[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const slicePath = join(sliceDir, `seg-${i}.wav`);
    if (!writeWavSlice(pcm, turn.start, turn.end, slicePath)) continue;
    const text = (await transcribe({ modelId: transcriberModelId, audioChunk: slicePath })).trim();
    if (text) segments.push({ ...turn, text });
  }

  const merged = mergeSpeakers(segments);
  const speakers = new Set(merged.map((s) => s.speaker)).size;
  const text = merged.map((s) => `Speaker ${s.speaker}: ${s.text}`).join("\n");
  audit?.record({ event: "note", durationMs: now() - t, extra: { role: "diarize", audioPath, speakers, segments: merged.length, chars: text.length } });
  return { text, segments: merged, speakers };
}
