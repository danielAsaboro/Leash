/**
 * Client-side audio helpers shared by Leash's text mic (LeashChat) and the hands-free
 * call overlay (VoiceCall). Browser-only — every export touches Web Audio / MediaRecorder,
 * so import these from `"use client"` components only.
 *
 * Centralizes the two things both surfaces need (WAV re-encoding for the on-device Parakeet
 * STT, which rejects webm/opus) plus everything the voice loop adds on top: an AudioContext
 * factory, short Web-Audio earcons (no asset files), the served TTS voice list, and the VAD
 * tuning constants kept in ONE place because they are mic/device-dependent (see plan risks).
 */

/* ───────────── AudioContext ───────────── */

/** Cross-browser `AudioContext` constructor (Safari still ships `webkitAudioContext`). */
export function getAudioContextCtor(): typeof AudioContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return window.AudioContext || (window as any).webkitAudioContext;
}

/** Create an AudioContext, optionally pinned to a sample rate (16 kHz for STT re-encode). */
export function makeAudioContext(sampleRate?: number): AudioContext {
  const Ctor = getAudioContextCtor();
  return sampleRate ? new Ctor({ sampleRate }) : new Ctor();
}

/* ───────────── WAV re-encode ───────────── */

/**
 * Decode recorded audio → 16 kHz mono 16-bit PCM WAV. The on-device transcriber (parakeet)
 * does NOT accept the browser's webm/opus (returns empty), so we re-encode to WAV first.
 * (Moved verbatim out of LeashChat so the call overlay can reuse it.)
 */
export async function blobToWav(blob: Blob): Promise<Blob> {
  const data = await blob.arrayBuffer();
  const ctx = makeAudioContext(16000);
  const audio = await ctx.decodeAudioData(data);
  void ctx.close();
  const samples = audio.getChannelData(0);
  const rate = audio.sampleRate;
  const ab = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(ab);
  const wr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  wr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

/* ───────────── Voices ───────────── */

/**
 * Voices we are willing to ask the local `qvac serve` for, by display label → served alias.
 * The serve resolves an unknown/extra voice down to the bare TTS model, but we only expose
 * what is actually configured (`qvac.config.json` → supertonic.config.voice = "F1") — no fake
 * voices (hard rule #4 / plan honesty note). Add a sibling alias here ONLY after verifying the
 * Supertonic voice ID exists; the picker auto-shows once this has more than one entry.
 */
export const VOICES: { label: string; value: string }[] = [{ label: "Supertonic F1", value: "F1" }];

/** The default voice (first entry) — what `/speak` falls back to on `model_not_found`. */
export const DEFAULT_VOICE = VOICES[0]!.value;

/** Allowlist of served voice aliases, mirrored by the `/speak` route for validation. */
export const VOICE_VALUES: string[] = VOICES.map((v) => v.value);

/* ───────────── Earcons ───────────── */

/**
 * Short Web-Audio cues for the call loop. Routed to `ctx.destination` (the speakers), NOT the
 * mic analyser, so they never trip VAD. Pure oscillator+gain envelopes — no asset files.
 */
export type Earcon = "listen" | "sent" | "error";

export function playEarcon(ctx: AudioContext, kind: Earcon): void {
  if (ctx.state === "closed") return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  // Gentle envelope so the blips don't click; peak kept low so they're unobtrusive.
  const peak = 0.08;
  if (kind === "listen") {
    // single soft ~660 Hz blip → "I'm listening"
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.start(now);
    osc.stop(now + 0.18);
  } else if (kind === "sent") {
    // rising 520 → 780 Hz → "got it, sending"
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.linearRampToValueAtTime(780, now + 0.14);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.22);
  } else {
    // low ~200 Hz → "something went wrong"
    osc.type = "sine";
    osc.frequency.setValueAtTime(200, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.start(now);
    osc.stop(now + 0.34);
  }
}

/* ───────────── VAD tuning ───────────── */

/**
 * Voice-activity-detection constants — ALL in one tunable place because they are
 * mic/device-dependent (plan open-risk: "VAD tuning"). Values are normalized RMS (0..1) over
 * the AnalyserNode time-domain buffer, and milliseconds.
 */
export const VAD = {
  /** RMS above this = speech onset (start capturing). */
  onsetThreshold: 0.04,
  /** RMS below this = silence (count toward end-of-utterance). */
  silenceThreshold: 0.025,
  /** Sustained energy above this DURING playback = barge-in (higher, to reject echo). */
  bargeInThreshold: 0.08,
  /** Onset must persist this long before we commit to capturing (rejects clicks). */
  onsetSustainMs: 150,
  /** Trailing silence this long ends the utterance (~1s). */
  silenceHangoverMs: 1000,
  /** Barge-in energy must persist this long during playback before we cut TTS. */
  bargeInSustainMs: 250,
  /** Keep this much audio BEFORE detected onset so the first word isn't clipped. */
  preRollMs: 300,
  /** Utterances shorter than this are treated as noise and ignored. */
  minUtteranceMs: 250,
  /** MediaRecorder timeslice — emit a chunk this often so pre-roll/slicing is fine-grained. */
  recorderTimesliceMs: 100,
} as const;
