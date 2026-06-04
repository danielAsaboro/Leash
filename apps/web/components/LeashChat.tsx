"use client";
import { useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputProvider, PromptInputBody, PromptInputTextarea, PromptInputFooter, PromptInputTools, PromptInputSubmit, PromptInputActionMenu, PromptInputActionMenuTrigger, PromptInputActionMenuContent, PromptInputActionAddAttachments, usePromptInputController, usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import { ToolView } from "./leash-tools.tsx";
import type { LeashMetadata, LeashUIMessage } from "@/lib/leash/types";

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
  return [md.model ?? "on-device", `${md.totalTokens} tok`, tps ? `${tps} tok/s` : ""].filter(Boolean).join(" · ");
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

/**
 * Decode recorded audio → 16 kHz mono 16-bit PCM WAV. The on-device transcriber (parakeet)
 * does NOT accept the browser's webm/opus (returns empty), so we re-encode to WAV first.
 */
async function blobToWav(blob: Blob): Promise<Blob> {
  const data = await blob.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctor({ sampleRate: 16000 });
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

/** 🎙 Voice input — record → WAV → on-device transcribe → drop the text into the composer. */
function MicButton({ disabled }: { disabled: boolean }) {
  const controller = usePromptInputController();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [errored, setErrored] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const toggle = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    setErrored(false);
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
        if (raw.size === 0) return;
        setTranscribing(true);
        try {
          const wav = await blobToWav(raw);
          const fd = new FormData();
          fd.append("file", wav, "speech.wav");
          const res = await fetch("/api/leash/transcribe", { method: "POST", body: fd });
          const data = (await res.json()) as { text?: string };
          const text = (data.text ?? "").trim();
          if (text) {
            const cur = controller.textInput.value;
            controller.textInput.setInput(cur ? `${cur} ${text}` : text);
          } else {
            setErrored(true);
          }
        } catch {
          setErrored(true);
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setErrored(true);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || transcribing}
      aria-label={recording ? "Stop recording" : "Record voice input"}
      title={recording ? "Stop & transcribe" : transcribing ? "Transcribing…" : errored ? "Couldn't transcribe — try again" : "Speak"}
      className={`chat-mic${recording ? " chat-mic-on" : ""}${errored ? " chat-mic-err" : ""}`}
    >
      {recording ? "● Rec" : transcribing ? "Transcribing…" : errored ? "🎙 ⚠" : "🎙"}
    </button>
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

export function LeashChat({ id, initialMessages }: { id: string; initialMessages: LeashUIMessage[] }) {
  const { messages, sendMessage, status, error, regenerate, stop } = useChat<LeashUIMessage>({
    id,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/leash/chat",
      // Send only the last message + trigger; the server rebuilds history from the store.
      prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => {
        if (trigger === "regenerate-message") return { body: { id, trigger, messageId } };
        return { body: { id, trigger: "submit-message", message: messages[messages.length - 1] } };
      },
    }),
    experimental_throttle: 50,
    onError: (e) => console.error("Leash chat error:", e),
  });
  const busy = status === "submitted" || status === "streaming";
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
            messages.map((m) => (
              <MessageView key={m.id} message={m} streaming={busy} onRegenerate={!busy ? () => regenerate({ messageId: m.id }) : undefined} />
            ))
          )}

          {error && (
            <div className="chat-error">
              <span>Something went wrong.</span>
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
              </PromptInputTools>
              {/* Stop while generating (status === streaming/submitted), else submit. */}
              <PromptInputSubmit status={status} onStop={stop} />
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>
    </TooltipProvider>
  );
}

function MessageView({ message, streaming, onRegenerate }: { message: LeashUIMessage; streaming: boolean; onRegenerate?: () => void }) {
  const { role } = message;
  const parts = message.parts as Part[];
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** On-device read-aloud of the answer text via /api/leash/speak (supertonic TTS). */
  const speak = async (text: string) => {
    if (speaking) {
      audioRef.current?.pause();
      setSpeaking(false);
      return;
    }
    if (!text.trim()) return;
    setSpeaking(true);
    try {
      const res = await fetch("/api/leash/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error("tts");
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setSpeaking(false);
        URL.revokeObjectURL(url);
      };
      await audio.play();
    } catch {
      setSpeaking(false);
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
            return <ToolView key={i} part={p} />;
          }
          return null;
        })}

        <div className="chat-foot">
          {meta && <span className="chat-meta">{meta}</span>}
          {answerText && (
            <button type="button" className="chat-regen" onClick={() => void speak(answerText)} title="Read aloud (on-device TTS)">
              {speaking ? "■ Stop" : "🔊 Read aloud"}
            </button>
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
