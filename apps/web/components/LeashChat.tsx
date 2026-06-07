"use client";
import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputProvider, PromptInputBody, PromptInputTextarea, PromptInputFooter, PromptInputTools, PromptInputSubmit, PromptInputActionMenu, PromptInputActionMenuTrigger, PromptInputActionMenuContent, PromptInputActionAddAttachments, usePromptInputController, usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import { Loader } from "@/components/ai-elements/loader";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolView } from "./leash-tools.tsx";
import { ElicitationCard } from "./ElicitationCard.tsx";
import { VoiceCall } from "./VoiceCall.tsx";
import { blobToWav } from "@/lib/leash/audio";
import { fetchWithTimeout, TIMEOUT } from "@/lib/http.ts";
import type { ElicitationView, LeashElicitationEvent, LeashMetadata, LeashUIMessage } from "@/lib/leash/types";

/**
 * The Leash chat surface (client) — Vercel AI Elements on the AI SDK, re-skinned with
 * the broadsheet palette. Persistence-aware: it's mounted with a chat `id` + the stored
 * `initialMessages`, and the transport sends only the last message + a trigger so the
 * server rebuilds history from the store (supporting submit *and* regenerate). Renders
 * the v6 message parts (markdown, reasoning, tools, sources) plus Stop, Error+Retry,
 * throttled streaming, per-message regenerate, and telemetry (model · tokens · tok/s).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

const SUGGESTIONS = ["What's in today's paper?", "What did I note about the mesh setup?", "What are my preferences?"];

const isToolPart = (p: Part): boolean => typeof p?.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");

/** "qwen3-4b · 142 tok · 18 tok/s" from message metadata, once finished. */
function telemetry(md: LeashMetadata | undefined): string | null {
  if (!md?.totalTokens) return null;
  const secs = md.createdAt && md.finishedAt ? (md.finishedAt - md.createdAt) / 1000 : 0;
  const tps = secs > 0 ? Math.round(md.totalTokens / secs) : 0;
  return [md.effort, md.model ?? "on-device", `${md.totalTokens} tok`, tps ? `${tps} tok/s` : ""].filter(Boolean).join(" · ");
}

/**
 * The on-device vision model's image loader only decodes PNG/JPEG. Browsers often hand us
 * other formats (webp from clipboard, gif, bmp…) which break the model mid-stream. Re-encode
 * any non-PNG/JPEG image attachment to PNG via a canvas before sending.
 */
async function toPngDataUrl(url: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return url;
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function normalizeImageFiles(files: any[]): Promise<any[]> {
  return Promise.all(
    files.map(async (f) => {
      const mt: string = f?.mediaType ?? "";
      if (!mt.startsWith("image/") || mt === "image/png" || mt === "image/jpeg") return f;
      try {
        const url = await toPngDataUrl(f.url);
        const name = String(f.filename ?? "image").replace(/\.\w+$/, "") + ".png";
        return { ...f, mediaType: "image/png", url, filename: name };
      } catch {
        return f; // best-effort; fall back to the original
      }
    })
  );
}

/** 🎙 Voice input — record → WAV → on-device transcribe → drop the text into the composer. */
function MicButton({ disabled }: { disabled: boolean }) {
  const controller = usePromptInputController();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Honest failure reason (permission / offline / model / no-speech) instead of a silent boolean.
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const toggle = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const raw = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (raw.size === 0) {
          setMicError("No audio captured.");
          return;
        }
        setTranscribing(true);
        try {
          const wav = await blobToWav(raw);
          const fd = new FormData();
          fd.append("file", wav, "speech.wav");
          const res = await fetch("/api/leash/transcribe", { method: "POST", body: fd });
          const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (!res.ok) throw new Error(data.error || `Transcription failed (HTTP ${res.status}).`);
          const text = (data.text ?? "").trim();
          if (text) {
            const cur = controller.textInput.value;
            controller.textInput.setInput(cur ? `${cur} ${text}` : text);
          } else {
            setMicError("No speech detected — try again.");
          }
        } catch (err) {
          setMicError(err instanceof Error ? err.message : "Transcription failed.");
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      // getUserMedia rejection: most often a denied permission.
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setMicError(denied ? "Microphone permission denied — allow it in your browser." : "Couldn't access the microphone.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || transcribing}
        aria-label={recording ? "Stop recording" : "Record voice input"}
        title={recording ? "Stop & transcribe" : transcribing ? "Transcribing…" : micError ? micError : "Speak"}
        className={`chat-mic${recording ? " chat-mic-on" : ""}${micError ? " chat-mic-err" : ""}`}
      >
        {recording ? "● Rec" : transcribing ? "Transcribing…" : micError ? "🎙 ⚠" : "🎙"}
      </button>
      {micError && (
        <span className="chat-mic-msg" role="status" title={micError}>
          {micError}
        </span>
      )}
    </>
  );
}

/** Inline thumbnails of the composer's pending attachments (with remove). */
function ComposerAttachments() {
  const { files, remove } = usePromptInputAttachments();
  if (files.length === 0) return null;
  return (
    <div className="chat-attachments">
      {files.map((f) => (
        <div key={f.id} className="chat-attachment">
          {f.mediaType?.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={f.url} alt={f.filename ?? "attachment"} />
          ) : (
            <span className="chat-attachment-file">{f.filename ?? "file"}</span>
          )}
          <button type="button" aria-label="Remove attachment" className="chat-attachment-x" onClick={() => remove(f.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Turn a useChat error into an honest, actionable line (offline vs model-not-loaded vs the raw message). */
export function friendlyChatError(error: Error): string {
  const m = (error?.message ?? "").toLowerCase();
  if (!m) return "Something went wrong talking to the on-device model.";
  if (m.includes("fetch failed") || m.includes("econnrefused") || m.includes("failed to fetch") || m.includes("connect")) {
    return "The on-device model service is offline. Start it with `npm run qvac`.";
  }
  if (m.includes("model_not_found") || m.includes("not available") || m.includes("not loaded")) {
    return "The chat model isn't loaded — check qvac.config.base.json → serve.models and restart `npm run qvac`.";
  }
  return error.message;
}

export function LeashChat({ id, initialMessages }: { id: string; initialMessages: LeashUIMessage[] }) {
  // Hands-free "call" overlay — shares THIS useChat instance (no second transport/store).
  const [callOpen, setCallOpen] = useState(false);
  // Pending MCP elicitation forms (server→user questions mid-tool-call). Fed by the
  // stream's transient `data-elicitation` parts; seeded from GET /elicitations on mount
  // so a reload mid-form recovers the card. Resolved/timed-out ids drop out.
  const [elicitations, setElicitations] = useState<ElicitationView[]>([]);
  useEffect(() => {
    fetchWithTimeout("/api/leash/elicitations", {}, TIMEOUT.probe)
      .then((r) => (r.ok ? r.json() : { elicitations: [] }))
      .then((d: { elicitations?: ElicitationView[] }) => setElicitations((prev) => (prev.length === 0 ? (d.elicitations ?? []) : prev)))
      .catch(() => {}); // best-effort seed — the stream's data-elicitation parts are the live path
  }, []);
  const { messages, sendMessage, status, error, regenerate, stop, addToolApprovalResponse } = useChat<LeashUIMessage>({
    id,
    messages: initialMessages,
    // Tool approvals ("Ask first" tools): once every approval card on the last assistant
    // message has an answer, resend it automatically so the run continues server-side.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: new DefaultChatTransport({
      api: "/api/leash/chat",
      // Send only the last message + trigger; the server rebuilds history from the store.
      prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => {
        if (trigger === "regenerate-message") return { body: { id, trigger, messageId } };
        // `voice: true` (set by the call overlay via sendMessage's body option) routes this turn
        // to the chat route's fast path (/no_think + 2-step tools). Text composer sends no body.
        const voice = (body as { voice?: boolean } | undefined)?.voice ?? false;
        return { body: { id, trigger: "submit-message", message: messages[messages.length - 1], voice } };
      },
    }),
    experimental_throttle: 50,
    onData: (part) => {
      if (part.type !== "data-elicitation") return;
      const ev = part.data as LeashElicitationEvent;
      setElicitations((prev) => (ev.kind === "open" ? [...prev.filter((e) => e.id !== ev.elicitation.id), ev.elicitation] : prev.filter((e) => e.id !== ev.id)));
    },
    onError: (e) => console.error("Leash chat error:", e),
  });
  const busy = status === "submitted" || status === "streaming";

  // Pending indicator (AI Elements Loader): `status === "submitted"` alone is not
  // enough here — the route emits its `start` part immediately, flipping status to
  // "streaming" while the on-device serve is still PREFILLING (10-30 s with zero
  // visible output). So: show the loader while busy AND the assistant hasn't rendered
  // anything yet (no non-empty text/reasoning part, no tool part); it disappears the
  // moment the first real part lands.
  const last = messages[messages.length - 1];
  const assistantVisible =
    last?.role === "assistant" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((last.parts as any[]) ?? []).some(
      (p) => ((p?.type === "text" || p?.type === "reasoning") && typeof p.text === "string" && p.text.trim().length > 0) || (typeof p?.type === "string" && p.type.startsWith("tool-")) || p?.type === "dynamic-tool",
    );
  const awaitingModel = busy && !assistantVisible;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ask = async (text: string, files?: any[]) => {
    const t = text.trim();
    // Re-encode non-PNG/JPEG images (e.g. webp) to PNG — the vision model can't decode them.
    const norm = files && files.length ? await normalizeImageFiles(files) : undefined;
    if ((t || (norm && norm.length)) && !busy) void sendMessage({ text: t, ...(norm && norm.length ? { files: norm } : {}) });
  };

  return (
    <TooltipProvider>
      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-[760px]">
          {messages.length === 0 ? (
            <ConversationEmptyState title="Ask Leash anything." description="Grounded in your private notes and The Understory — all on-device.">
              <p className="chat-empty-title">Ask Leash anything.</p>
              <p className="chat-empty-sub">Grounded in your private notes and The Understory — all on-device. Home &amp; Activity arrive once configured.</p>
              <div className="chat-suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            messages.map((m, idx) => (
              <MessageView
                key={m.id}
                message={m}
                streaming={busy}
                onRegenerate={!busy ? () => regenerate({ messageId: m.id }) : undefined}
                // Approval cards are actionable only on the LAST message of an idle chat —
                // historical cards render as inert chips.
                approval={idx === messages.length - 1 && status === "ready" ? { respond: addToolApprovalResponse } : undefined}
              />
            ))
          )}

          {/* Pending state — the model hasn't produced anything visible yet (request
              queued or the serve is prefilling). Without this the page sits blank for
              the whole prefill and only the input box hints anything is happening. */}
          {awaitingModel && (
            <div className="flex items-center gap-2 py-3" style={{ color: "var(--color-faint)" }} role="status" aria-live="polite">
              <Loader size={15} />
              <Shimmer as="span" className="text-sm" duration={1.6}>
                Thinking…
              </Shimmer>
            </div>
          )}

          {/* Pending MCP elicitation forms — an MCP server is waiting on the user. */}
          {elicitations.map((e) => (
            <ElicitationCard key={e.id} elicitation={e} onDone={(doneId) => setElicitations((prev) => prev.filter((x) => x.id !== doneId))} />
          ))}

          {error && (
            <div className="chat-error">
              <span>⚠ {friendlyChatError(error)}</span>
              <button type="button" onClick={() => regenerate()}>
                Retry
              </button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="chat-composer">
        {/* Provider gives us a controller (for the mic to drop text into the box) + shared attachments. */}
        <PromptInputProvider>
          <PromptInput className="chat-composer-inner mx-auto max-w-[760px]" accept="image/*" onSubmit={(message) => ask(message.text ?? "", message.files)}>
            <PromptInputBody>
              {/* Visible thumbnails of attached images (with remove). */}
              <ComposerAttachments />
              <PromptInputTextarea placeholder="Ask about your notes, your paper, or attach an image…" />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                {/* Attach an image → the route routes that turn to the vision model. */}
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="Attach an image" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                {/* 🎙 Voice input → on-device transcription → text dropped into the box to review/send. */}
                <MicButton disabled={busy} />
                {/* 📞 Call → hands-free, audio-only voice loop over the SAME conversation. */}
                <button
                  type="button"
                  onClick={() => setCallOpen(true)}
                  aria-label="Start hands-free voice call"
                  title="Call — hands-free voice mode"
                  className="chat-mic chat-call-btn"
                >
                  📞 Call
                </button>
              </PromptInputTools>
              {/* Stop while generating (status === streaming/submitted), else submit. */}
              <PromptInputSubmit status={status} onStop={stop} />
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>

      {/* Hands-free call overlay — fed the LIVE useChat handles so spoken turns land in this
          same transcript/store; closing returns to the text chat. */}
      <VoiceCall
        open={callOpen}
        onClose={() => setCallOpen(false)}
        messages={messages}
        sendMessage={sendMessage}
        status={status}
        error={error}
        stop={stop}
      />
    </TooltipProvider>
  );
}

/** Approval handle passed down only when the card should be actionable (last message, idle). */
export interface ApprovalHandle {
  respond: (args: { id: string; approved: boolean; reason?: string }) => void;
}

function MessageView({ message, streaming, onRegenerate, approval }: { message: LeashUIMessage; streaming: boolean; onRegenerate?: () => void; approval?: ApprovalHandle }) {
  const { role } = message;
  const parts = message.parts as Part[];
  // Read-aloud is a small state machine: idle → loading (synthesizing) → playing → idle.
  // Clicking while loading/playing cancels (aborts the fetch / stops playback). Failures
  // surface an inline, actionable message instead of silently resetting.
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">("idle");
  const [ttsError, setTtsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Stop/cancel any in-flight synthesis or playback and return to idle. */
  const stopSpeak = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    setTtsState("idle");
  };

  /** On-device read-aloud of the answer text via /api/leash/speak (supertonic TTS). */
  const speak = async (text: string) => {
    if (ttsState !== "idle") {
      stopSpeak(); // toggle: cancel synthesis or stop playback
      return;
    }
    if (!text.trim()) return;
    setTtsError(null);
    setTtsState("loading");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/leash/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const info = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(info.error || `Read aloud failed (HTTP ${res.status}).`);
      }
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setTtsState("idle");
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setTtsError("Couldn't play the synthesized audio.");
        setTtsState("idle");
        URL.revokeObjectURL(url);
      };
      await audio.play();
      setTtsState("playing");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setTtsState("idle"); // user cancelled — not an error
        return;
      }
      setTtsError(err instanceof Error ? err.message : "Read aloud failed.");
      setTtsState("idle");
    }
  };

  if (role === "user") {
    const text = parts.filter((p: Part) => p.type === "text").map((p: Part) => p.text ?? "").join("");
    const images = parts.filter((p: Part) => p.type === "file" && typeof p.url === "string" && String(p.mediaType ?? "").startsWith("image/"));
    return (
      <Message from="user">
        <MessageContent>
          {images.map((p: Part, i: number) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={p.url} alt={p.filename ?? "attachment"} className="chat-attached-img" />
          ))}
          {text}
        </MessageContent>
      </Message>
    );
  }

  const meta = telemetry(message.metadata);
  const answerText = parts.filter((p: Part) => p.type === "text").map((p: Part) => p.text ?? "").join("");

  return (
    <Message from="assistant">
      <MessageContent>
        {parts.map((p: Part, i: number) => {
          if (p.type === "reasoning") {
            return (
              <Reasoning key={i} isStreaming={streaming && !p.text} defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>{p.text ?? ""}</ReasoningContent>
              </Reasoning>
            );
          }
          if (p.type === "text") {
            return <MessageResponse key={i}>{p.text ?? ""}</MessageResponse>;
          }
          if (isToolPart(p)) {
            return <ToolView key={i} part={p} approval={approval} />;
          }
          return null;
        })}

        <div className="chat-foot">
          {meta && <span className="chat-meta">{meta}</span>}
          {answerText && (
            <button
              type="button"
              className={`chat-regen${ttsState !== "idle" ? " is-active" : ""}${ttsError ? " is-err" : ""}`}
              onClick={() => void speak(answerText)}
              title={
                ttsState === "loading"
                  ? "Synthesizing… click to cancel"
                  : ttsState === "playing"
                    ? "Stop"
                    : "Read aloud (on-device TTS)"
              }
            >
              {ttsState === "loading" ? "⏳ Synthesizing… (cancel)" : ttsState === "playing" ? "■ Stop" : "🔊 Read aloud"}
            </button>
          )}
          {ttsError && (
            <span className="chat-tts-err" role="status" title={ttsError}>
              ⚠ {ttsError}
            </span>
          )}
          {onRegenerate && (
            <button type="button" className="chat-regen" onClick={onRegenerate} title="Regenerate">
              ↻ Regenerate
            </button>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}
