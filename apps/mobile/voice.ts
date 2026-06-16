/**
 * On-device voice for Leash mobile — speech-to-text (Whisper) and text-to-speech (Supertonic),
 * both through @qvac/sdk only (never a cloud API). Recording + playback use expo-av (expo-audio
 * black-screens under JSC — see CLAUDE.md / memory mobile-jsc-not-hermes).
 *
 * The pipeline mirrors the web app (apps/web/lib/leash/audio.ts) but skips its webm→wav re-encode:
 * iOS records LINEAR PCM at 16 kHz mono directly, which is exactly what `transcribe()` wants.
 *
 *   record (16 kHz mono WAV)  →  transcribe({ audioChunk })  →  text
 *   text  →  textToSpeech().buffer (Int16 @ 44.1 kHz)  →  WAV file  →  play
 */
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import {
  downloadAsset,
  loadModel,
  unloadModel,
  transcribe,
  textToSpeech,
  type ModelProgressUpdate,
  WHISPER_EN_SMALL_Q8_0,
  TTS_EN_SUPERTONIC_Q8_0,
} from "@qvac/sdk";

/** Supertonic always emits PCM at this rate; needed to wrap the buffer as WAV. */
const TTS_SAMPLE_RATE = 44_100;

// ── Model loading (lazy + memoized) ──────────────────────────────────────────
// Whisper/Supertonic download once (online) then run offline. We keep them loaded
// between turns; the caller can unload on memory pressure.

let sttId: string | null = null;
let ttsId: string | null = null;
let sttLoading: Promise<string> | null = null;
let ttsLoading: Promise<string> | null = null;

/** Currently-loaded ids (or null) — read by the Models/Services panels for live state. */
export const getSttId = (): string | null => sttId;
export const getTtsId = (): string | null => ttsId;

/** Unload Whisper to free memory; it lazily reloads on the next mic tap. */
export async function unloadStt(): Promise<void> {
  const id = sttId;
  sttId = null;
  sttLoading = null;
  if (id) await unloadModel({ modelId: id, clearStorage: false }).catch(() => {});
}

/** Unload Supertonic to free memory; it lazily reloads on the next spoken reply. */
export async function unloadTts(): Promise<void> {
  const id = ttsId;
  ttsId = null;
  ttsLoading = null;
  if (id) await unloadModel({ modelId: id, clearStorage: false }).catch(() => {});
}

/** Load Whisper (English small, Q8) for transcription. Returns the model id. */
export function loadStt(onProgress?: (pct: number) => void): Promise<string> {
  if (sttId) return Promise.resolve(sttId);
  if (sttLoading) return sttLoading;
  sttLoading = (async () => {
    await downloadAsset({
      assetSrc: WHISPER_EN_SMALL_Q8_0,
      onProgress: (p: ModelProgressUpdate) => onProgress?.(Math.round(p.percentage)),
    });
    const id = await loadModel({
      modelSrc: WHISPER_EN_SMALL_Q8_0,
      modelType: "whisper",
      onProgress: (p: ModelProgressUpdate) => onProgress?.(Math.round(p.percentage)),
    });
    sttId = id;
    return id;
  })();
  try {
    return sttLoading;
  } finally {
    sttLoading.catch(() => {
      sttLoading = null;
    });
  }
}

/** Load Supertonic TTS (English, F1 voice). Returns the model id. */
export function loadTts(onProgress?: (pct: number) => void): Promise<string> {
  if (ttsId) return Promise.resolve(ttsId);
  if (ttsLoading) return ttsLoading;
  ttsLoading = (async () => {
    await downloadAsset({
      assetSrc: TTS_EN_SUPERTONIC_Q8_0,
      onProgress: (p: ModelProgressUpdate) => onProgress?.(Math.round(p.percentage)),
    });
    const id = await loadModel({
      modelSrc: TTS_EN_SUPERTONIC_Q8_0,
      modelType: "tts",
      modelConfig: {
        ttsEngine: "supertonic",
        language: "en",
        voice: "F1",
        ttsSpeed: 1.05,
        ttsNumInferenceSteps: 5,
      },
      onProgress: (p: ModelProgressUpdate) => onProgress?.(Math.round(p.percentage)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    ttsId = id;
    return id;
  })();
  try {
    return ttsLoading;
  } finally {
    ttsLoading.catch(() => {
      ttsLoading = null;
    });
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

/** iOS records LINEAR PCM straight to a .wav at 16 kHz mono — no decode/resample needed. */
const REC_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: 256_000,
  },
  ios: {
    extension: ".wav",
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.MAX,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: 256_000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 128_000 },
};

export type RecHandle = { recording: Audio.Recording };

/**
 * Start recording. `onLevel` (if given) reports the live mic level as 0..1 (derived from the
 * metering dBFS), driving the call-screen VAD + orb. Resolves once recording is actually running.
 */
export async function startRecording(opts?: { onLevel?: (level: number) => void }): Promise<RecHandle> {
  const perm = await Audio.requestPermissionsAsync();
  if (!perm.granted) throw new Error("Microphone permission denied.");
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

  const recording = new Audio.Recording();
  if (opts?.onLevel) {
    recording.setProgressUpdateInterval(80);
    recording.setOnRecordingStatusUpdate((s) => {
      if (s.isRecording && typeof s.metering === "number") opts.onLevel!(dbToLevel(s.metering));
    });
  }
  await recording.prepareToRecordAsync(REC_OPTIONS);
  await recording.startAsync();
  return { recording };
}

/** Stop recording and return the WAV file path (file:// scheme stripped for the SDK). */
export async function stopRecording(handle: RecHandle): Promise<string> {
  const { recording } = handle;
  try {
    await recording.stopAndUnloadAsync();
  } catch {
    // already stopped / unloaded — fall through to the URI we have
  }
  // Restore playback routing to the speaker (recording mode forces the earpiece on iOS).
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
  const uri = recording.getURI();
  if (!uri) throw new Error("Recording produced no file.");
  return uri;
}

/** Map metering dBFS (~ -60 silence … 0 loud) to a 0..1 level for VAD + the orb ring. */
function dbToLevel(db: number): number {
  const floor = -60;
  if (db <= floor) return 0;
  if (db >= 0) return 1;
  return (db - floor) / -floor;
}

// ── Transcription ────────────────────────────────────────────────────────────

/**
 * Transcribe a 16 kHz mono WAV file to text via Whisper. Tries the file path first (the
 * SDK decodes WAV natively — verified against jfk.wav on desktop). If the on-device worker
 * can't read the app-sandbox path, falls back to handing it the audio as base64: the SDK's
 * non-string branch does `audioChunk.toString("base64")`, so an object that returns the
 * file's base64 from that call routes the bytes through with no filesystem dependency.
 */
export async function transcribeWav(modelId: string, wavUri: string): Promise<string> {
  const path = wavUri.replace(/^file:\/\//, "");
  let text = "";
  try {
    text = ((await transcribe({ modelId, audioChunk: path })) ?? "").trim();
  } catch {
    // fall through to the base64 path
  }
  if (text) return text;

  const b64 = await FileSystem.readAsStringAsync(wavUri, { encoding: FileSystem.EncodingType.Base64 });
  const asBase64 = { toString: (enc?: string) => (enc === "base64" ? b64 : b64) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  text = ((await transcribe({ modelId, audioChunk: asBase64 as any })) ?? "").trim();
  return text;
}

/** Size of a recorded file in KB (0 if missing) — used to diagnose empty captures. */
export async function fileKB(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    const size = info.exists ? ((info as { size?: number }).size ?? 0) : 0;
    return Math.round(size / 1024);
  } catch {
    return 0;
  }
}

// ── Text-to-speech ───────────────────────────────────────────────────────────

/** Synthesize `text` to a WAV file in the cache dir and return its file:// URI. */
let ttsSeq = 0;
export async function synthToFile(modelId: string, text: string): Promise<string> {
  const result = textToSpeech({ modelId, text, inputType: "text", stream: false } as Parameters<
    typeof textToSpeech
  >[0]);
  const pcm = (await (result as { buffer: Promise<ArrayLike<number>> }).buffer) as ArrayLike<number>;
  const wav = pcmToWav(pcm, TTS_SAMPLE_RATE);
  const path = `${FileSystem.cacheDirectory}tts-${(ttsSeq += 1)}.wav`;
  await FileSystem.writeAsStringAsync(path, toBase64(wav), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return path;
}

// ── Playback ─────────────────────────────────────────────────────────────────

let current: Audio.Sound | null = null;

/** Play a WAV file to completion. Resolves when playback finishes (or is stopped). */
export async function playWav(uri: string): Promise<void> {
  await stopPlayback();
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
  const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
  current = sound;
  return new Promise<void>((resolve) => {
    sound.setOnPlaybackStatusUpdate((s) => {
      if (!s.isLoaded || s.didJustFinish) {
        sound.setOnPlaybackStatusUpdate(null);
        void sound.unloadAsync().catch(() => {});
        if (current === sound) current = null;
        resolve();
      }
    });
  });
}

/** Stop any in-flight playback (used for barge-in). */
export async function stopPlayback(): Promise<void> {
  const s = current;
  current = null;
  if (!s) return;
  s.setOnPlaybackStatusUpdate(null);
  await s.stopAsync().catch(() => {});
  await s.unloadAsync().catch(() => {});
}

// ── WAV header ───────────────────────────────────────────────────────────────
// Ported from packages/senses/src/tts.ts, but Buffer-free (Uint8Array + DataView) so it can't
// depend on a Buffer global being present in the RN/JSC main thread. Wraps Int16 PCM as a WAV.

function pcmToWav(samples: ArrayLike<number>, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    view.setInt16(44 + i * 2, v, true);
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64-encode bytes without relying on Buffer/btoa (absent under React Native JSC). */
function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}
