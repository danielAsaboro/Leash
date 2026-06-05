"use client";
import { useEffect, useRef, useState } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { LeashUIMessage } from "@/lib/leash/types";
import { friendlyChatError } from "./LeashChat.tsx";
import { blobToWav, makeAudioContext, playEarcon, VAD, VOICES, VOICE_VALUES, DEFAULT_VOICE } from "@/lib/leash/audio";

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

interface VoiceCallProps {
  open: boolean;
  onClose: () => void;
  messages: LeashUIMessage[];
  sendMessage: UseChatHelpers<LeashUIMessage>["sendMessage"];
  status: UseChatHelpers<LeashUIMessage>["status"];
  error: UseChatHelpers<LeashUIMessage>["error"];
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

/** Drop empty / punctuation-only transcripts so noise never gets sent. */
function cleanTranscript(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  // Only punctuation/whitespace (parakeet sometimes returns "." / "?" on noise) → ignore.
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return "";
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

export function VoiceCall({ open, onClose, messages, sendMessage, status, error }: VoiceCallProps) {
  const [callState, setCallStateRaw] = useState<CallState>("idle");
  const [userCaption, setUserCaption] = useState<string | null>(null);
  const [assistantCaption, setAssistantCaption] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);

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

  // Turn / TTS bookkeeping.
  const awaitingTurnRef = useRef(false);
  const lastSpokenIdRef = useRef<string | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsUrlRef = useRef<string | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);

  const setCallState = (s: CallState) => {
    stateRef.current = s;
    setCallStateRaw(s);
  };

  /* ───────────── Recorder ───────────── */

  const startRecorder = () => {
    const stream = streamRef.current;
    if (!stream) return;
    // Defensively stop any prior recorder (e.g. the one speak() started for barge-in) so we
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

  const cleanupTts = () => {
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
    cleanupTts();
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") playEarcon(audioCtxRef.current, "error");
    setNote(message);
    setCallState("error");
  };

  /* ───────────── Speak (TTS playback) ───────────── */

  const speak = async (text: string) => {
    if (closedRef.current) return;
    setCallState("speaking");
    // No recorder runs during playback — the analyser alone watches for barge-in. This keeps
    // Leash's own (echo-attenuated) TTS out of any captured bytes; a fresh recorder starts only
    // once a real barge-in is detected.
    bargeSinceRef.current = null;
    const ac = new AbortController();
    speakAbortRef.current = ac;
    try {
      const res = await fetch("/api/leash/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: voiceRef.current }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const info = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        // Honest fallback: a missing voice resets to the confirmed default with a one-line note.
        if (info.code === "model_not_found" && voiceRef.current !== DEFAULT_VOICE) {
          voiceRef.current = DEFAULT_VOICE;
          setVoice(DEFAULT_VOICE);
          setNote(`Voice unavailable — using ${DEFAULT_VOICE}. Tap to retry.`);
        }
        throw new Error(info.error || `Speech failed (HTTP ${res.status}).`);
      }
      if (closedRef.current) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      ttsUrlRef.current = url;
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      audio.onended = () => {
        cleanupTts();
        reArm();
      };
      audio.onerror = () => {
        cleanupTts();
        fail("Couldn't play the synthesized audio.");
      };
      await audio.play();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // barge-in / teardown
      fail(friendlyChatError(err instanceof Error ? err : new Error("Speech failed.")));
    }
  };

  /* ───────────── Barge-in ───────────── */

  const bargeIn = () => {
    if (stateRef.current !== "speaking") return;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    cleanupTts(); // stop playback
    bargeSinceRef.current = null;
    const now = performance.now();
    captureStartRef.current = now;
    lastVoiceRef.current = now;
    // Start capturing the barge-in utterance now (fresh recorder → header-complete, echo-free).
    startRecorder();
    setCallState("capturing");
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
      // Tag as a voice turn → the chat route answers fast (/no_think + 2-step tools).
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
        if (rms > VAD.onsetThreshold) {
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
        if (rms > VAD.silenceThreshold) lastVoiceRef.current = now;
        else if (now - lastVoiceRef.current >= VAD.silenceHangoverMs) {
          if (DEBUG_VAD) console.log("[VAD] silence → end utterance");
          void endUtterance();
        }
      } else if (s === "speaking") {
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
    void arm();
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

    // Live-update the assistant caption while streaming (no speaking yet).
    if (status === "streaming" && last && last.role === "assistant") {
      const live = spokenText(last);
      if (live) setAssistantCaption(live);
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
    const text = spokenText(last).trim();
    if (!text) {
      // Tool/image-only turn — nothing to speak; note it and keep the call going.
      setAssistantCaption("(no spoken reply)");
      reArm();
      return;
    }
    setAssistantCaption(text);
    void speak(text);
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

  return (
    <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Leash voice call">
      <div className="call-stage">
        <div className={`call-orb-wrap${isError ? " is-error" : ""}`}>
          <div className={`call-orb ${orbClass}`} />
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
