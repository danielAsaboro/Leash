"use client";
import { useEffect, useRef, useState } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { LeashUIMessage } from "@/lib/leash/types";
import { friendlyChatError } from "./LeashChat.tsx";
import { blobToWav, makeAudioContext, playEarcon, VAD, VOICES, VOICE_VALUES, DEFAULT_VOICE } from "@/lib/leash/audio";
import { stripMarkdownForSpeech, segmentSentences } from "@/lib/leash/speech-text";
import { pickFillerPhrase } from "@/lib/leash/filler";
import { Persona, type PersonaState } from "@/components/ai-elements/persona";

/**
 * VoiceCall — Leash's hands-free, audio-only "call" mode.
 *
 * A full-screen overlay launched from the text chat. It does NOT own a `useChat` — the parent
 * (`LeashChat`) passes the LIVE handles down, so spoken turns land in the same transcript/store
 * and persist through the unchanged transport. Everything is on-device: Parakeet STT
 * (`/api/leash/transcribe`), the chat route (via `sendMessage`), and Supertonic TTS
 * (`/api/leash/speak`).
 *
 * The loop is a small state machine driven by mic RMS (an AnalyserNode + rAF):
 *   idle → listening → capturing → transcribing → thinking → speaking → (listening)
 * plus `error` and `denied`. A continuously-running MediaRecorder (re-started per listening
 * phase, so every built blob is a complete decodable webm with a header) captures the utterance
 * bytes; the analyser — not recorder start/stop — gates the utterance via VAD. Barge-in: sustained
 * energy above a higher threshold while Leash is speaking stops playback and starts capturing.
 *
 * VAD/earcon tuning lives in `lib/leash/audio.ts` (mic/device-dependent — one place to tweak).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

type CallState = "idle" | "listening" | "capturing" | "transcribing" | "thinking" | "speaking" | "error" | "denied";

// Flip to true while tuning VAD thresholds — logs RMS + transitions to the console.
const DEBUG_VAD = false;

// Spoken "thinking" filler: masks the silent gap before sentence 1 of a real answer is synthesized
// (the spoken analogue of the text chat streaming its `<think>` panel). The phrase is RELEVANT to the
// query — `pickFillerPhrase` classifies the transcript into a tool domain and picks a varied phrase
// (e.g. "Let me dig through your notes." for a notes query) — then synthesized per-turn via the same
// fast on-device TTS. (A per-query LLM filler is ~10s+ here, slower than the answer, so we classify
// cheaply instead of generating.) Played when the turn is still `thinking` after FILLER_DELAY_MS AND
// its audio is ready; killed the instant real audio is ready.
const FILLER_DELAY_MS = 700;

interface VoiceCallProps {
  open: boolean;
  onClose: () => void;
  messages: LeashUIMessage[];
  sendMessage: UseChatHelpers<LeashUIMessage>["sendMessage"];
  status: UseChatHelpers<LeashUIMessage>["status"];
  error: UseChatHelpers<LeashUIMessage>["error"];
  /** Abort the in-flight generation — used by barge-in while `thinking`/`speaking`. */
  stop: UseChatHelpers<LeashUIMessage>["stop"];
}

/** Assistant spoken text = the text parts only (reasoning/tool parts are NOT spoken). */
function spokenText(message: LeashUIMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  const parts = (message.parts ?? []) as Part[];
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * Minimum letters/digits of real content for a transcript to count (phantom-rejection, per the
 * QVAC voice-assistant doc's `MIN_UTTERANCE_CHARS`). The doc uses 3 for Whisper; our STT is Parakeet
 * and this is a conversational assistant, so 2 — it kills single-char hallucinations ("I", "u", ".")
 * while keeping real one-word replies ("no", "ok", "hi").
 */
const MIN_TRANSCRIPT_CHARS = 2;

/** Drop empty / punctuation-only / phantom transcripts so STT noise never gets sent. */
function cleanTranscript(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  // Only punctuation/whitespace (parakeet sometimes returns "." / "?" on noise) → ignore.
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return "";
  // Bracketed non-linguistic cues hallucinated from near-silence, e.g. "[BLANK_AUDIO]".
  if (/^\[[^\]]*\]$/.test(t)) return "";
  // Too few real letters/digits → a phantom; ignore.
  if (t.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_TRANSCRIPT_CHARS) return "";
  return t;
}

const STATE_LABEL: Record<CallState, string> = {
  idle: "",
  listening: "Listening…",
  capturing: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Leash is thinking…",
  speaking: "Leash is speaking…",
  error: "Something went wrong",
  denied: "Microphone blocked",
};

export function VoiceCall({ open, onClose, messages, sendMessage, status, error, stop }: VoiceCallProps) {
  const [callState, setCallStateRaw] = useState<CallState>("idle");
  const [userCaption, setUserCaption] = useState<string | null>(null);
  const [assistantCaption, setAssistantCaption] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);
  // If the Rive persona fails to load (e.g. WebGL2 unavailable), fall back to the CSS orb.
  const [personaFailed, setPersonaFailed] = useState(false);

  // Mirrors of state read inside the rAF loop / async callbacks (no stale closures, no re-render).
  const stateRef = useRef<CallState>("idle");
  const voiceRef = useRef<string>(DEFAULT_VOICE);
  const closedRef = useRef(true);

  // Audio graph.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const floatBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);

  // Capture (continuous recorder, re-armed per listening/speaking phase → always header-complete).
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // VAD timing (performance.now() ms).
  const onsetSinceRef = useRef<number | null>(null);
  const bargeSinceRef = useRef<number | null>(null);
  const lastVoiceRef = useRef<number>(0);
  const captureStartRef = useRef<number>(0);
  /** While listening, ignore mic onset until this timestamp (post-playback reverb cooldown). */
  const cooldownUntilRef = useRef<number>(0);

  // Turn / TTS bookkeeping.
  const awaitingTurnRef = useRef(false);
  const lastSpokenIdRef = useRef<string | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsUrlRef = useRef<string | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);

  // Progressive (sentence-chunked) TTS: synthesize + play one sentence at a time, starting the
  // moment sentence 1 is complete in the stream — so first audio lands seconds before generation
  // finishes on longer (`deep`) replies. `/speak` is non-streaming (one WAV/call); we pipeline by
  // sentence and keep a one-ahead prefetch so inter-sentence gaps stay small.
  const ttsQueueRef = useRef<string[]>([]); // complete sentences awaiting synth+play
  const ttsPlayingRef = useRef(false); // a chunk is currently fetching or playing
  const spokenCharsRef = useRef(0); // how far into the current reply we've dispatched to the queue
  const currentMsgIdRef = useRef<string | null>(null); // the assistant msg the cursor tracks
  const turnDoneRef = useRef(false); // the reply has fully arrived (flush + re-arm when queue drains)
  const ttsPrefetchRef = useRef<{ sentence: string; promise: Promise<Blob>; ac: AbortController } | null>(null);

  // Spoken-filler bookkeeping (per turn). The phrase is synthesized on the fly, so the clip URL is
  // owned by the turn and revoked when the filler stops. `armed` = the 700ms delay has passed;
  // `done` = a filler already played (or was cancelled) this turn — both gate `maybePlayFiller`,
  // which fires only once both the delay AND the synthesized audio are ready, and we're still thinking.
  const fillerUrlRef = useRef<string | null>(null);
  const fillerSynthAbortRef = useRef<AbortController | null>(null);
  const fillerAudioRef = useRef<HTMLAudioElement | null>(null);
  const fillerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillerArmedRef = useRef(false);
  const fillerDoneRef = useRef(false);

  const setCallState = (s: CallState) => {
    stateRef.current = s;
    setCallStateRaw(s);
  };

  /* ───────────── Recorder ───────────── */

  const startRecorder = () => {
    const stream = streamRef.current;
    if (!stream) return;
    // Defensively stop any prior recorder (e.g. the one a barge-in started) so we
    // never run two at once or leak one holding the stream.
    const prev = recorderRef.current;
    recorderRef.current = null;
    if (prev && prev.state !== "inactive") {
      prev.onstop = null;
      prev.ondataavailable = null;
      try {
        prev.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorderRef.current = rec;
      rec.start(VAD.recorderTimesliceMs);
    } catch {
      /* MediaRecorder unsupported / already running — ignore. */
    }
  };

  /** Stop the recorder and resolve the captured utterance (a complete webm with header). */
  const stopRecorderForBlob = (): Promise<Blob | null> => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec || rec.state === "inactive") {
      const fallback = chunksRef.current.length ? new Blob(chunksRef.current, { type: "audio/webm" }) : null;
      chunksRef.current = [];
      return Promise.resolve(fallback);
    }
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }) : null;
        chunksRef.current = [];
        resolve(blob);
      };
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
  };

  /* ───────────── TTS teardown ───────────── */

  /** Detach + revoke the CURRENT chunk's audio only (between-sentence cleanup — does NOT drain the
   * queue, so the next sentence still plays). */
  const detachCurrentAudio = () => {
    const audio = ttsAudioRef.current;
    ttsAudioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
    }
    if (ttsUrlRef.current) {
      URL.revokeObjectURL(ttsUrlRef.current);
      ttsUrlRef.current = null;
    }
  };

  /** Full TTS teardown — every stop-point (barge-in, fail, cleanup, thinking-barge-in) calls this:
   * drain the sentence queue, abort the in-flight `/speak` + the one-ahead prefetch, detach the
   * current chunk, and reset the cursor so the next turn starts clean. */
  const cleanupTts = () => {
    ttsQueueRef.current = [];
    turnDoneRef.current = false;
    spokenCharsRef.current = 0;
    currentMsgIdRef.current = null;
    ttsPlayingRef.current = false;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    if (ttsPrefetchRef.current) {
      ttsPrefetchRef.current.ac.abort();
      ttsPrefetchRef.current = null;
    }
    detachCurrentAudio();
  };

  /* ───────────── Spoken filler ───────────── */

  /**
   * Warm the on-device TTS at call-open (fire-and-forget). The FIRST Supertonic synth after idle is
   * cold (~10s); every one after is ~0.3s. Warming here means turn 1's filler AND the first real
   * answer's sentence-1 synth are both warm. The blob is discarded — this is purely a warmup.
   */
  const warmTts = async () => {
    try {
      const res = await fetch("/api/leash/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "One moment.", voice: voiceRef.current }),
      });
      if (res.ok) await res.blob(); // consume to complete the synth so the model is warm
    } catch {
      /* offline → no warmup; the call degrades to a (cold) first synth, still works */
    }
  };

  /** Play the synthesized filler iff: still `thinking`, not already done, the 700ms delay has passed,
   * AND the audio is ready. Fired from both the delay timer and the synth's resolve — whichever is last. */
  const maybePlayFiller = () => {
    if (closedRef.current || fillerDoneRef.current) return;
    if (stateRef.current !== "thinking") return; // reply already started — anti-overlap guard
    if (!fillerArmedRef.current || !fillerUrlRef.current) return; // need BOTH the delay and the audio
    fillerDoneRef.current = true;
    const audio = new Audio(fillerUrlRef.current);
    fillerAudioRef.current = audio;
    audio.onended = () => {
      if (fillerAudioRef.current === audio) fillerAudioRef.current = null;
      if (fillerUrlRef.current) {
        URL.revokeObjectURL(fillerUrlRef.current); // filler finished on its own — release its URL
        fillerUrlRef.current = null;
      }
    };
    void audio.play().catch(() => {
      /* autoplay/decode hiccup → just stay silent */
    });
  };

  /** Synthesize a query-relevant filler phrase for THIS turn (abortable). On success, stash the URL
   * and try to play; on abort/error, stay silent (graceful — no filler this turn). */
  const startFillerSynth = (phrase: string) => {
    const ac = new AbortController();
    fillerSynthAbortRef.current = ac;
    void (async () => {
      try {
        const res = await fetch("/api/leash/speak", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: phrase, voice: voiceRef.current }),
          signal: ac.signal,
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (closedRef.current || fillerDoneRef.current) return; // stopped/closed while synthesizing
        fillerUrlRef.current = URL.createObjectURL(blob);
        maybePlayFiller();
      } catch {
        /* abort (real reply started) / offline → no filler, graceful */
      }
    })();
  };

  /** Atomic filler stop: cancel the timer + in-flight synth, stop the playing clip, revoke the
   * turn's URL, and mark done so a late synth-resolve can't fire after the real reply starts. */
  const stopFiller = () => {
    if (fillerTimerRef.current != null) {
      clearTimeout(fillerTimerRef.current);
      fillerTimerRef.current = null;
    }
    fillerSynthAbortRef.current?.abort();
    fillerSynthAbortRef.current = null;
    const audio = fillerAudioRef.current;
    fillerAudioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
    }
    if (fillerUrlRef.current) {
      URL.revokeObjectURL(fillerUrlRef.current);
      fillerUrlRef.current = null;
    }
    fillerArmedRef.current = false;
    fillerDoneRef.current = true; // block any late play until the next turn re-arms
  };

  /* ───────────── Re-arm (back to listening) ───────────── */

  const reArm = () => {
    if (closedRef.current) return;
    onsetSinceRef.current = null;
    bargeSinceRef.current = null;
    startRecorder();
    setCallState("listening");
  };

  /* ───────────── Fatal error ───────────── */

  const fail = (message: string) => {
    if (closedRef.current) return;
    awaitingTurnRef.current = false;
    void stopRecorderForBlob();
    stopFiller();
    cleanupTts();
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") playEarcon(audioCtxRef.current, "error");
    setNote(message);
    setCallState("error");
  };

  /* ───────────── Speak (progressive sentence-chunked TTS) ───────────── */

  /** Synthesize one sentence → WAV Blob (abortable). Honest voice fallback: a missing voice resets
   * to the confirmed default with a one-line note. Throws on abort (barge-in/teardown) or error. */
  const fetchSpeakBlob = async (text: string, signal: AbortSignal): Promise<Blob> => {
    const res = await fetch("/api/leash/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: voiceRef.current }),
      signal,
    });
    if (!res.ok) {
      const info = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (info.code === "model_not_found" && voiceRef.current !== DEFAULT_VOICE) {
        voiceRef.current = DEFAULT_VOICE;
        setVoice(DEFAULT_VOICE);
        setNote(`Voice unavailable — using ${DEFAULT_VOICE}. Tap to retry.`);
      }
      throw new Error(info.error || `Speech failed (HTTP ${res.status}).`);
    }
    return res.blob();
  };

  /** Fire a one-ahead synth of the NEXT queued sentence so its WAV is ready before the current
   * chunk ends (keeps inter-sentence gaps small). No-op if one is already in flight or queue empty. */
  const kickPrefetch = () => {
    if (closedRef.current || ttsPrefetchRef.current) return;
    const next = ttsQueueRef.current[0];
    if (!next) return;
    const ac = new AbortController();
    const promise = fetchSpeakBlob(next, ac.signal);
    promise.catch(() => {}); // mark handled — a prefetch dropped on teardown must not warn
    ttsPrefetchRef.current = { sentence: next, promise, ac };
  };

  /**
   * Drive the sentence queue: synthesize + play one sentence at a time, in order, never overlapping.
   * Called whenever the queue grows (streaming/finish) or a chunk ends. When the queue is empty AND
   * the turn is done, this is where we re-arm the mic (replaces the old single `audio.onended`).
   * No recorder runs during playback — the analyser alone watches for barge-in (echo-free capture).
   */
  const pumpTts = () => {
    if (closedRef.current) return;
    if (ttsPlayingRef.current) return; // a chunk is already fetching/playing — it will re-pump
    if (ttsQueueRef.current.length === 0) {
      if (turnDoneRef.current) {
        turnDoneRef.current = false;
        reArm(); // whole reply spoken — back to listening
      }
      return;
    }
    ttsPlayingRef.current = true;
    const sentence = ttsQueueRef.current.shift() as string;
    bargeSinceRef.current = null;

    // Reuse the one-ahead prefetch if it matches the head we just dequeued; else fetch fresh.
    let blobPromise: Promise<Blob>;
    const pre = ttsPrefetchRef.current;
    if (pre && pre.sentence === sentence) {
      ttsPrefetchRef.current = null;
      speakAbortRef.current = pre.ac; // so teardown can abort this fetch
      blobPromise = pre.promise;
    } else {
      if (pre) {
        pre.ac.abort();
        ttsPrefetchRef.current = null;
      }
      const ac = new AbortController();
      speakAbortRef.current = ac;
      blobPromise = fetchSpeakBlob(sentence, ac.signal);
    }

    blobPromise
      .then((blob) => {
        if (closedRef.current) return;
        stopFiller(); // real audio is ready — drop the filler that covered the synth gap
        if (stateRef.current !== "speaking") setCallState("speaking"); // only the first chunk flips state
        const url = URL.createObjectURL(blob);
        ttsUrlRef.current = url;
        const audio = new Audio(url);
        ttsAudioRef.current = audio;
        kickPrefetch(); // start synthesizing the next sentence while this one plays
        audio.onended = () => {
          detachCurrentAudio();
          ttsPlayingRef.current = false;
          // Gate the mic briefly only once the WHOLE reply has finished (not between sentences).
          if (ttsQueueRef.current.length === 0 && turnDoneRef.current) {
            cooldownUntilRef.current = performance.now() + VAD.postPlaybackCooldownMs;
          }
          pumpTts();
        };
        audio.onerror = () => {
          detachCurrentAudio();
          ttsPlayingRef.current = false;
          fail("Couldn't play the synthesized audio.");
        };
        void audio.play().catch(() => {
          // Autoplay/decode hiccup → don't hang the queue; drop this chunk and continue.
          detachCurrentAudio();
          ttsPlayingRef.current = false;
          pumpTts();
        });
      })
      .catch((err) => {
        ttsPlayingRef.current = false;
        if (err instanceof DOMException && err.name === "AbortError") return; // barge-in / teardown
        fail(friendlyChatError(err instanceof Error ? err : new Error("Speech failed.")));
      });
  };

  /* ───────────── Barge-in ───────────── */

  /**
   * Interrupt the current turn and start capturing a fresh utterance. Fires on a sustained barge-in
   * during `speaking` OR `thinking` (incl. while a filler plays). Under progressive TTS the reply may
   * still be generating, so we `stop()` the generation, stop the filler, drain the TTS queue, and
   * clear `awaitingTurnRef` (so the completion effect can't resume speaking over the interruption),
   * then arm a fresh recorder for the new utterance.
   */
  const interrupt = () => {
    void stop(); // abort the in-flight generation (may still be streaming)
    awaitingTurnRef.current = false;
    stopFiller();
    cleanupTts(); // drain queue, abort in-flight /speak + prefetch, detach current audio
    bargeSinceRef.current = null;
    const now = performance.now();
    captureStartRef.current = now;
    lastVoiceRef.current = now;
    // Fresh recorder → header-complete, echo-free capture of the barge-in utterance.
    startRecorder();
    setCallState("capturing");
  };

  /** Sustained energy during `speaking`/`thinking` → interrupt and capture the new utterance. */
  const bargeIn = () => {
    const s = stateRef.current;
    if (s !== "speaking" && s !== "thinking") return;
    if (DEBUG_VAD) console.log("[VAD] barge-in from", s);
    interrupt();
  };

  /* ───────────── End of utterance → transcribe → send ───────────── */

  const endUtterance = async () => {
    if (stateRef.current !== "capturing") return;
    const durationMs = performance.now() - captureStartRef.current;
    setCallState("transcribing");
    const blob = await stopRecorderForBlob();
    if (closedRef.current) return;
    // Too short or no bytes → noise; ignore and re-arm (nothing sent).
    if (!blob || durationMs < VAD.minUtteranceMs) {
      reArm();
      return;
    }
    const ac = new AbortController();
    transcribeAbortRef.current = ac;
    try {
      const wav = await blobToWav(blob);
      const fd = new FormData();
      fd.append("file", wav, "speech.wav");
      const res = await fetch("/api/leash/transcribe", { method: "POST", body: fd, signal: ac.signal });
      transcribeAbortRef.current = null;
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `Transcription failed (HTTP ${res.status}).`);
      if (closedRef.current) return;
      const text = cleanTranscript(data.text);
      if (!text) {
        reArm(); // garbled / empty → ignore, stay listening
        return;
      }
      setUserCaption(text);
      setAssistantCaption(null);
      awaitingTurnRef.current = true;
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") playEarcon(audioCtxRef.current, "sent");
      setCallState("thinking");
      // Dynamic, query-relevant spoken filler: synthesize a phrase for THIS request's domain right now
      // (no LLM — `pickFillerPhrase` classifies the transcript), and arm a 700ms delay. It plays once
      // both are ready and we're still thinking; a fast reply flips to `speaking` first (stopFiller in
      // pumpTts), so it's skipped. Reset the per-turn flags + drop any stale URL before starting.
      if (fillerUrlRef.current) {
        URL.revokeObjectURL(fillerUrlRef.current);
        fillerUrlRef.current = null;
      }
      fillerArmedRef.current = false;
      fillerDoneRef.current = false;
      startFillerSynth(pickFillerPhrase(text));
      fillerTimerRef.current = setTimeout(() => {
        fillerTimerRef.current = null;
        fillerArmedRef.current = true;
        maybePlayFiller();
      }, FILLER_DELAY_MS);
      // Tag as a voice turn → the chat route answers fast (/no_think + dynamic effort tier).
      void sendMessage({ text }, { body: { voice: true } });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      fail(friendlyChatError(err instanceof Error ? err : new Error("Transcription failed.")));
    }
  };

  /* ───────────── rAF loop: RMS → orb ring + VAD ───────────── */

  const startRaf = () => {
    if (rafRef.current != null) return;
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const analyser = analyserRef.current;
      const buf = floatBufRef.current;
      if (!analyser || !buf) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const s = stateRef.current;

      // Live-level ring while the mic is "open" for input.
      if (ringRef.current) {
        const active = s === "listening" || s === "capturing";
        const scale = active ? 1 + Math.min(rms, 0.4) * 1.6 : 1;
        ringRef.current.style.transform = `scale(${scale.toFixed(3)})`;
      }

      const now = performance.now();
      if (s === "listening") {
        if (now < cooldownUntilRef.current) {
          onsetSinceRef.current = null; // mic settling after playback — ignore onset
        } else if (rms > VAD.onsetThreshold) {
          if (onsetSinceRef.current == null) onsetSinceRef.current = now;
          else if (now - onsetSinceRef.current >= VAD.onsetSustainMs) {
            onsetSinceRef.current = null;
            captureStartRef.current = now;
            lastVoiceRef.current = now;
            if (DEBUG_VAD) console.log("[VAD] onset → capturing", rms.toFixed(3));
            setCallState("capturing");
          }
        } else {
          onsetSinceRef.current = null;
        }
      } else if (s === "capturing") {
        // Hard cap so a continuous talker (no silence gap) can't capture forever.
        if (now - captureStartRef.current >= VAD.maxUtteranceMs) {
          if (DEBUG_VAD) console.log("[VAD] max utterance → end");
          void endUtterance();
        } else if (rms > VAD.silenceThreshold) {
          lastVoiceRef.current = now;
        } else if (now - lastVoiceRef.current >= VAD.silenceHangoverMs) {
          if (DEBUG_VAD) console.log("[VAD] silence → end utterance");
          void endUtterance();
        }
      } else if (s === "speaking" || s === "thinking") {
        // Barge-in: sustained energy above the (echo-rejecting) threshold while Leash speaks OR
        // thinks (incl. while a filler plays) interrupts the turn and captures the new utterance.
        if (rms > VAD.bargeInThreshold) {
          if (bargeSinceRef.current == null) bargeSinceRef.current = now;
          else if (now - bargeSinceRef.current >= VAD.bargeInSustainMs) {
            if (DEBUG_VAD) console.log("[VAD] barge-in", rms.toFixed(3));
            bargeIn();
          }
        } else {
          bargeSinceRef.current = null;
        }
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  /* ───────────── Arm mic ───────────── */

  const arm = async () => {
    setNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (closedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const ctx = makeAudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      src.connect(analyser); // analyser is NOT connected to destination — no mic monitoring
      sourceRef.current = src;
      analyserRef.current = analyser;
      floatBufRef.current = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      playEarcon(ctx, "listen");
      startRecorder();
      setCallState("listening");
      startRaf();
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      if (denied) {
        setNote("Microphone permission denied — allow it in your browser, then Retry.");
        setCallState("denied");
      } else {
        setNote("Couldn't access the microphone.");
        setCallState("error");
      }
    }
  };

  /* ───────────── Full teardown ───────────── */

  const cleanup = () => {
    closedRef.current = true;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    chunksRef.current = [];
    cleanupTts();
    stopFiller(); // cancels the in-flight filler synth + timer and revokes the per-turn filler URL
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    sourceRef.current = null;
    try {
      analyserRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
    awaitingTurnRef.current = false;
    onsetSinceRef.current = null;
    bargeSinceRef.current = null;
    cooldownUntilRef.current = 0;
  };

  /* ───────────── Open / close lifecycle ───────────── */

  useEffect(() => {
    if (!open) return;
    closedRef.current = false;
    voiceRef.current = voice;
    setUserCaption(null);
    setAssistantCaption(null);
    setNote(null);
    setCallState("idle");
    // Don't (re)speak whatever assistant message is already the latest when the call opens.
    const last = messages[messages.length - 1];
    lastSpokenIdRef.current = last && last.role === "assistant" ? last.id : null;
    // Reset per-turn filler state, then warm the TTS so turn 1's filler + first answer synth aren't cold.
    fillerArmedRef.current = false;
    fillerDoneRef.current = false;
    void arm();
    void warmTts();
    return cleanup;
    // Intentionally only re-run on open: arm/cleanup own the audio lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the voice ref in sync for the next /speak call.
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  /* ───────────── Turn completion → speak ───────────── */

  useEffect(() => {
    if (!open || !awaitingTurnRef.current) return;
    const last = messages[messages.length - 1];

    // Streaming: caption shows the full live RAW text (readable); the TTS queue is fed COMPLETE
    // sentences as they finish, so synthesis of sentence 1 starts before generation ends.
    if (status === "streaming" && last && last.role === "assistant") {
      const raw = spokenText(last);
      if (raw) setAssistantCaption(raw);
      // New assistant message for this turn → reset the per-reply TTS cursor.
      if (last.id !== currentMsgIdRef.current) {
        currentMsgIdRef.current = last.id;
        spokenCharsRef.current = 0;
        turnDoneRef.current = false;
        ttsQueueRef.current = [];
      }
      const full = stripMarkdownForSpeech(raw);
      const slice = full.slice(spokenCharsRef.current);
      const { sentences, rest } = segmentSentences(slice);
      if (sentences.length) {
        for (const s of sentences) ttsQueueRef.current.push(s);
        spokenCharsRef.current += slice.length - rest.length;
        pumpTts();
      }
      return;
    }

    if (status === "error") {
      awaitingTurnRef.current = false;
      fail(error ? friendlyChatError(error) : "The on-device model failed to reply.");
      return;
    }

    // Turn finished: the awaited assistant message is settled.
    if (status !== "ready") return;
    if (!last || last.role !== "assistant") return;
    if (last.id === lastSpokenIdRef.current) return; // dedup (throttle / regenerate guards)
    awaitingTurnRef.current = false;
    lastSpokenIdRef.current = last.id;
    const raw = spokenText(last);
    const full = stripMarkdownForSpeech(raw);
    if (!full.trim()) {
      // Tool/image-only turn — nothing to speak; note it and keep the call going.
      stopFiller(); // no real reply will speak — don't let a pending filler fire into silence
      cleanupTts(); // drop any partial cursor/queue from this turn
      setAssistantCaption("(no spoken reply)");
      reArm();
      return;
    }
    setAssistantCaption(raw.trim());
    // Adopt the cursor if a fast turn skipped the streaming tick entirely.
    if (last.id !== currentMsgIdRef.current) {
      currentMsgIdRef.current = last.id;
      spokenCharsRef.current = 0;
      ttsQueueRef.current = [];
    }
    // Flush the trailing partial sentence (the `rest`) plus any remaining complete sentences.
    const slice = full.slice(spokenCharsRef.current);
    const { sentences, rest } = segmentSentences(slice);
    for (const s of sentences) ttsQueueRef.current.push(s);
    const tail = rest.trim();
    if (tail) ttsQueueRef.current.push(tail);
    spokenCharsRef.current += slice.length;
    turnDoneRef.current = true;
    pumpTts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, messages, open]);

  if (!open) return null;

  const orbClass =
    callState === "thinking"
      ? "is-thinking"
      : callState === "speaking"
        ? "is-speaking"
        : callState === "error" || callState === "denied"
          ? "is-error"
          : "is-listening"; // idle/listening/capturing/transcribing all show the listening orb
  const isError = callState === "error" || callState === "denied";
  const showRetry = callState === "denied";
  const showResume = callState === "error";
  // The on-device call avatar (Rive persona, vendored offline). Mirrors the call state machine.
  const personaState: PersonaState =
    callState === "speaking"
      ? "speaking"
      : callState === "thinking" || callState === "transcribing"
        ? "thinking"
        : callState === "listening" || callState === "capturing"
          ? "listening"
          : isError
            ? "asleep"
            : "idle";

  return (
    <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Leash voice call">
      <div className="call-stage">
        <div className={`call-orb-wrap${isError ? " is-error" : ""}`}>
          {personaFailed ? (
            <div className={`call-orb ${orbClass}`} />
          ) : (
            <Persona state={personaState} variant="obsidian" className="call-persona size-40" onLoadError={() => setPersonaFailed(true)} />
          )}
          <div ref={ringRef} className="call-orb-ring" />
        </div>

        <div className={`call-state${isError ? " is-error" : ""}`} role="status">
          {STATE_LABEL[callState]}
        </div>

        <div className="call-captions">
          {userCaption && (
            <div className="call-cap-user">
              <span className="call-cap-label">You</span>
              {userCaption}
            </div>
          )}
          {assistantCaption && (
            <div className={`call-cap-assistant${assistantCaption === "(no spoken reply)" ? " call-cap-muted" : ""}`}>
              <span className="call-cap-label">Leash</span>
              {assistantCaption}
            </div>
          )}
        </div>

        {note && <p className={`call-note${isError ? " is-error" : ""}`}>{note}</p>}

        <div className="call-controls">
          <button type="button" className="call-hangup" onClick={onClose} aria-label="Hang up">
            ✕ Hang up
          </button>

          {showRetry && (
            <button type="button" className="call-action" onClick={() => void arm()}>
              ↻ Retry
            </button>
          )}
          {showResume && (
            <button
              type="button"
              className="call-action"
              onClick={() => {
                setNote(null);
                setUserCaption(null);
                setAssistantCaption(null);
                // Resume in place if the audio graph survived the error; otherwise re-arm fully
                // (e.g. a mic-access failure tore nothing down but never built the graph).
                if (streamRef.current && analyserRef.current) reArm();
                else void arm();
              }}
            >
              ↻ Resume
            </button>
          )}

          {/* Voice picker — shown only when more than one verified voice exists (no fake voices). */}
          {VOICES.length > 1 && (
            <select
              className="call-voice"
              value={voice}
              onChange={(e) => setVoice(VOICE_VALUES.includes(e.target.value) ? e.target.value : DEFAULT_VOICE)}
              aria-label="Voice"
            >
              {VOICES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
