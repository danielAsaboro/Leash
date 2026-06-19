"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BrainIcon, CheckIcon, ChevronDownIcon, ClockIcon, CopyIcon, DotIcon, ListChecksIcon, NetworkIcon, PaperclipIcon, PhoneIcon, RefreshCcwIcon, SparklesIcon, SquareIcon, Volume2Icon, XIcon } from "lucide-react";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse, MessageActions, MessageAction } from "@/components/ai-elements/message";
import { ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought";
import { Sources, SourcesTrigger, SourcesContent, Source } from "@/components/ai-elements/sources";
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Context, ContextTrigger, ContextContent, ContextContentHeader, ContextContentBody } from "@/components/ai-elements/context";
import { Queue, QueueSection, QueueSectionTrigger, QueueSectionLabel, QueueSectionContent, QueueList, QueueItem, QueueItemContent, QueueItemActions, QueueItemAction } from "@/components/ai-elements/queue";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import { InlineCitation, InlineCitationCard, InlineCitationCardBody, InlineCitationSource, InlineCitationQuote } from "@/components/ai-elements/inline-citation";
import { HoverCardTrigger } from "@/components/ui/hover-card";
import { Badge } from "@/components/ui/badge";
import { PromptInput, PromptInputProvider, PromptInputBody, PromptInputTextarea, PromptInputFooter, PromptInputTools, PromptInputSubmit, PromptInputActionMenu, PromptInputActionMenuTrigger, PromptInputActionMenuContent, PromptInputActionAddAttachments, usePromptInputController, usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningTrigger, ReasoningContent, useReasoning } from "@/components/ai-elements/reasoning";
import { Loader } from "@/components/ai-elements/loader";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { toolMeta, toolName, ToolCard, collectSources } from "./leash-tools.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { SkillEventCard } from "./SkillEventCard.tsx";
import { kindOf } from "../lib/leash/model-rows.ts";
import { appConfirm } from "../lib/prompt.ts";
import type { PlanData } from "@/lib/leash/types";
import { ElicitationCard } from "./ElicitationCard.tsx";
import { VoiceCall } from "./VoiceCall.tsx";
import { MessageFeedback } from "./MessageFeedback.tsx";
import { toast } from "./Toast.tsx";
import { blobToWav } from "@/lib/leash/audio";
import { fetchWithTimeout, TIMEOUT } from "@/lib/http.ts";
import type { ConductorDecisionEvent, ElicitationView, LeashElicitationEvent, LeashMetadata, LeashSkillEvent, LeashUIMessage } from "@/lib/leash/types";

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
const isSkillPart = (p: Part): p is { type: "data-skill"; data: LeashSkillEvent } => p?.type === "data-skill";
const isConductorPart = (p: Part): p is { type: "data-conductor"; data: ConductorDecisionEvent } => p?.type === "data-conductor";

/** "qwen3-4b · 142 tok · 18 tok/s" from message metadata, once finished. */
function telemetry(md: LeashMetadata | undefined): string | null {
  if (!md?.totalTokens) return null;
  const secs = md.createdAt && md.finishedAt ? (md.finishedAt - md.createdAt) / 1000 : 0;
  const tps = secs > 0 ? Math.round(md.totalTokens / secs) : 0;
  return [md.effort, md.model ?? "on-device", `${md.totalTokens} tok`, tps ? `${tps} tok/s` : ""].filter(Boolean).join(" · ");
}

/**
 * Split an assistant message's parts into a ChainOfThought *timeline* (reasoning / tool /
 * skill / intermediate-text nodes) and the *final answer* (trailing text). The answer is
 * the run of text parts after the last non-text part — that's what renders below the
 * timeline as the response, so the connecting spine terminates at the answer. With no
 * non-text part at all, everything is the answer (a plain reply, no timeline).
 */
interface TimelineNode {
  kind: "reasoning" | "tool" | "skill" | "text" | "plan" | "route-decision";
  part: Part;
  idx: number;
}
const isPlanPart = (p: Part): boolean => p?.type === "data-plan";
/** A submit_plan tool part renders as a Plan card only while proposed/rejected — once approved the
 *  `data-plan` execution part owns the card (so we don't show two). */
const isPlanTool = (p: Part): boolean => isToolPart(p) && toolName(p) === "submit_plan";
function buildTimeline(parts: Part[]): { nodes: TimelineNode[]; answer: string } {
  const items: TimelineNode[] = [];
  parts.forEach((p, idx) => {
    if (p?.type === "reasoning") items.push({ kind: "reasoning", part: p, idx });
    else if (isPlanPart(p)) items.push({ kind: "plan", part: p, idx });
    else if (isConductorPart(p)) items.push({ kind: "route-decision", part: p, idx });
    else if (isToolPart(p)) items.push({ kind: "tool", part: p, idx });
    else if (isSkillPart(p)) items.push({ kind: "skill", part: p, idx });
    else if (p?.type === "text") items.push({ kind: "text", part: p, idx });
  });
  let lastNonText = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind !== "text") {
      lastNonText = i;
      break;
    }
  }
  const answerOf = (slice: TimelineNode[]) => slice.map((n) => n.part.text ?? "").join("");
  if (lastNonText === -1) return { nodes: [], answer: answerOf(items) };
  return { nodes: items.slice(0, lastNonText + 1), answer: answerOf(items.slice(lastNonText + 1)) };
}

/** Reasoning trigger inner content (no brain icon — the step already carries it on the spine). */
function ThinkingLabel() {
  const { isStreaming, isOpen, duration } = useReasoning();
  return (
    <>
      {isStreaming || duration === 0 ? (
        <Shimmer duration={1}>Thinking…</Shimmer>
      ) : duration === undefined ? (
        <span>Thought process</span>
      ) : (
        <span>Thought for {duration}s</span>
      )}
      <ChevronDownIcon className={cn("size-3.5 transition-transform", isOpen ? "rotate-180" : "rotate-0")} />
    </>
  );
}

/** A reasoning part as a timeline node: brain icon on the spine + a collapsible "Thought for Ns". */
function ReasoningStep({ text, live }: { text: string; live: boolean }) {
  const streaming = live && !text.trim();
  return (
    <ChainOfThoughtStep
      icon={BrainIcon}
      status={streaming ? "active" : "complete"}
      label={
        <Reasoning className="mb-0" isStreaming={streaming} defaultOpen={false}>
          <ReasoningTrigger className="text-current">
            <ThinkingLabel />
          </ReasoningTrigger>
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      }
    />
  );
}

/** Build a proposed/rejected PlanData from a submit_plan tool part's input (for the approval card). */
function planFromTool(part: Part): PlanData {
  const input = (part.input ?? {}) as { title?: string; steps?: string[] };
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const id = String(part.toolCallId ?? "plan");
  return {
    id,
    ...(input.title ? { title: input.title } : {}),
    status: part.state === "output-denied" ? "rejected" : "proposed",
    steps: steps.map((text, i) => ({ id: `${id}-s${i}`, text, status: "pending" })),
  };
}

/** Conductor route-decision step: shows "local <alias>" or "→ peer <alias> (<tier>)" + reason. */
function RouteDecisionStep({ event }: { event: ConductorDecisionEvent }) {
  const label = event.peerKey ? `→ peer ${event.alias} (${event.tier})` : `local ${event.alias}`;
  return (
    <span className="text-xs" style={{ color: "var(--color-faint)", fontFamily: "var(--font-mono)" }} title={event.reason}>
      {label}
      {event.reason ? <span className="ml-1 opacity-60">· {event.reason}</span> : null}
    </span>
  );
}

/** Render one timeline node as a ChainOfThought step (its card nests as the step's children). */
function renderTimelineNode(node: TimelineNode, live: boolean, approval?: ApprovalHandle) {
  const key = `n-${node.idx}`;
  // Plan mode: the executing plan (data-plan part) renders the live Plan card.
  if (node.kind === "plan") {
    return (
      <ChainOfThoughtStep key={key} icon={ListChecksIcon} label={<span>Plan</span>}>
        <PlanCard plan={node.part.data as PlanData} />
      </ChainOfThoughtStep>
    );
  }
  // The proposed plan (submit_plan, approval-requested) renders the Plan card WITH the approve/
  // reject/adjust gate; once approved/executed the data-plan node above owns the card, so render null.
  if (node.kind === "tool" && isPlanTool(node.part)) {
    const st = node.part.state as string;
    if (st !== "approval-requested" && st !== "output-denied") return null;
    const handle = approval;
    const apprId = node.part.approval?.id as string | undefined;
    const respond = (approved: boolean, reason?: string) => {
      handle?.respond({ id: apprId!, approved, ...(reason ? { reason } : {}) });
      toast[approved ? "success" : "info"](approved ? "Plan approved" : "Plan sent back");
    };
    const actionable = !!handle && !!apprId && st === "approval-requested";
    return (
      <ChainOfThoughtStep key={key} icon={ListChecksIcon} label={<span>{st === "output-denied" ? "Plan rejected" : "Plan proposed — review"}</span>}>
        <PlanCard
          plan={planFromTool(node.part)}
          {...(actionable
            ? {
                onApprove: () => respond(true),
                onReject: () => respond(false, "rejected by user"),
                onAdjust: (note: string) => respond(false, `Adjust the plan and submit a new one: ${note}`),
              }
            : {})}
        />
      </ChainOfThoughtStep>
    );
  }
  if (node.kind === "reasoning") return <ReasoningStep key={key} text={node.part.text ?? ""} live={live} />;
  if (node.kind === "route-decision") {
    return <ChainOfThoughtStep key={key} icon={NetworkIcon} label={<RouteDecisionStep event={node.part.data as ConductorDecisionEvent} />} />;
  }
  if (node.kind === "skill") {
    return <ChainOfThoughtStep key={key} icon={SparklesIcon} label={<SkillEventCard event={node.part.data} />} />;
  }
  if (node.kind === "tool") {
    const m = toolMeta(node.part);
    return (
      <ChainOfThoughtStep key={key} icon={m.icon} status={m.status} label={<span className={m.error ? "text-[color:var(--color-brick)]" : undefined}>{m.label}</span>}>
        <ToolCard part={node.part} approval={approval} />
      </ChainOfThoughtStep>
    );
  }
  // Intermediate text (a plain-sentence node, like the reference's DotIcon step).
  if (!node.part.text?.trim()) return null;
  return <ChainOfThoughtStep key={key} icon={DotIcon} label={<MessageResponse>{node.part.text}</MessageResponse>} />;
}

/** One cited source as an InlineCitation hover pill (`[N]` badge → title/url/snippet card). A
 *  custom trigger avoids the upstream `new URL()` that would throw on url-less private notes. */
function CitationPill({ n, source }: { n: number; source: { title: string; snippet?: string; url?: string } }) {
  return (
    <InlineCitation className="cite-pill-wrap">
      <InlineCitationCard>
        <HoverCardTrigger asChild>
          <Badge variant="secondary" className="cite-pill rounded-full">
            {n}
          </Badge>
        </HoverCardTrigger>
        <InlineCitationCardBody>
          <div className="cite-body">
            <InlineCitationSource title={source.title} {...(source.url ? { url: source.url } : {})} />
            {source.snippet ? <InlineCitationQuote>{source.snippet}</InlineCitationQuote> : null}
          </div>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}

/**
 * The answer text + a graceful inline-citation strip. If the model emitted `[N]` markers that map
 * to this message's numbered RAG sources, render those as hover-card pills beneath the answer
 * (the markers stay in the prose, reading naturally). No valid markers → just the answer, unchanged
 * — so this never regresses a normal reply. Block-level markdown rules out true in-sentence pills.
 */
function CitedAnswer({ text, sources }: { text: string; sources: Array<{ kind: string; title: string; snippet: string; url?: string }> }) {
  const cited: number[] = [];
  if (sources.length) {
    const seen = new Set<number>();
    for (const m of text.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= sources.length && !seen.has(n)) {
        seen.add(n);
        cited.push(n);
      }
    }
    cited.sort((a, b) => a - b);
  }
  return (
    <>
      <MessageResponse>{text}</MessageResponse>
      {cited.length > 0 && (
        <div className="cited-strip" aria-label="Cited sources">
          {cited.map((n) => (
            <CitationPill key={n} n={n} source={sources[n - 1]!} />
          ))}
        </div>
      )}
    </>
  );
}

/** Is the message's last timeline node already showing an active/streaming affordance? */
function lastNodeActive(nodes: TimelineNode[], live: boolean): boolean {
  const last = nodes[nodes.length - 1];
  if (!last) return false;
  if (last.kind === "tool") return toolMeta(last.part).status === "active";
  if (last.kind === "reasoning") return live && !(last.part.text ?? "").trim();
  return false;
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
 * 🎙 Voice input — AI Elements `SpeechInput`, forced ON-DEVICE: record → WAV → on-device
 * transcribe (`/api/leash/transcribe`, Parakeet) → drop the text into the composer. The
 * component is configured to use MediaRecorder (never the browser Web Speech API, which would
 * ship audio to Google's cloud — see speech-input.tsx). Failures surface inline via `onError`.
 */
function MicButton({ disabled }: { disabled: boolean }) {
  const controller = usePromptInputController();
  const [micError, setMicError] = useState<string | null>(null);

  return (
    <>
      <SpeechInput
        size="icon"
        disabled={disabled}
        aria-label="Record voice input (on-device transcription)"
        title="Speak — on-device transcription"
        className="chat-mic-el size-9"
        onSpeechError={(m) => {
          setMicError(m);
          toast.error(m);
        }}
        onAudioRecorded={async (blob) => {
          setMicError(null);
          const wav = await blobToWav(blob);
          const fd = new FormData();
          fd.append("file", wav, "speech.wav");
          const res = await fetch("/api/leash/transcribe", { method: "POST", body: fd });
          const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (!res.ok) throw new Error(data.error || `Transcription failed (HTTP ${res.status}).`);
          return (data.text ?? "").trim();
        }}
        onTranscriptionChange={(text) => {
          const cur = controller.textInput.value;
          controller.textInput.setInput(cur ? `${cur} ${text}` : text);
          toast.success("Transcription added");
        }}
      />
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
    return "The on-device model service isn’t running. Open Brain → Models and start Model Serve.";
  }
  if (m.includes("model_not_found") || m.includes("not available") || m.includes("not loaded")) {
    return "No chat model is loaded. Open Brain → Models, download a chat model (e.g. Qwen3-4B), then load it / start Model Serve.";
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
  // Plan mode — a per-conversation toggle (persisted in localStorage). When on, the turn is sent
  // with `plan: true`; the route makes the model draft a plan you approve before it runs. A ref
  // mirrors it so the transport (built once) reads the live value.
  const [planMode, setPlanMode] = useState(false);
  const planModeRef = useRef(false);
  // Restore the per-conversation toggle on mount / id change (client only). A remount (e.g. a
  // soft refresh after a turn) re-runs this and re-reads the saved value, so the toggle survives.
  useEffect(() => {
    let on = false;
    try {
      on = window.localStorage.getItem(`leash-plan-${id}`) === "1";
    } catch {
      /* private mode — default off */
    }
    setPlanMode(on);
    planModeRef.current = on;
  }, [id]);
  // Plain handler — NOT a side-effect inside the setState updater (dev Strict Mode invokes updaters
  // twice, which previously double-wrote localStorage and could flip the saved value). `planModeRef`
  // is the source of truth for the toggle's current value (kept in sync below).
  const togglePlanMode = () => {
    const next = !planModeRef.current;
    planModeRef.current = next;
    setPlanMode(next);
    toast.info(`Plan mode ${next ? "on" : "off"}`);
    try {
      window.localStorage.setItem(`leash-plan-${id}`, next ? "1" : "0");
    } catch {
      /* private mode / quota — the in-memory ref still drives this session */
    }
  };

  // Chat model picker — the user chooses which CONFIGURED model drives this conversation (mirrors the
  // AI Elements model-selector). A ref feeds the built-once transport so the choice rides every turn;
  // empty = let the server pick the configured default (provider.resolvedChatAlias).
  const [chatModels, setChatModels] = useState<{ alias: string; loaded: boolean }[]>([]);
  const [chatModelAlias, setChatModelAlias] = useState("");
  const chatModelRef = useRef("");
  useEffect(() => {
    let alive = true;
    fetch("/api/leash/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((inv: { configured?: { alias: string | null; loaded: boolean; isDefault: boolean; addon?: string | null }[] }) => {
        if (!alive) return;
        // Only CHAT models can drive a conversation — exclude mmproj projectors, embeddings, ASR/TTS,
        // OCR, etc. (kindOf maps the catalog `addon`; multimodal VLMs are addon "llm" → "text", so
        // they stay). Picking an mmproj as the chat model is why chat failed with "model isn't loaded".
        const rows = (inv.configured ?? []).filter((r) => r.alias && kindOf(r.addon) === "text") as { alias: string; loaded: boolean; isDefault: boolean }[];
        setChatModels(rows.map((r) => ({ alias: r.alias, loaded: r.loaded })));
        let saved = "";
        try {
          saved = window.localStorage.getItem(`leash-model-${id}`) ?? "";
        } catch {
          /* private mode */
        }
        const pick = saved && rows.some((r) => r.alias === saved) ? saved : rows.find((r) => r.isDefault)?.alias ?? rows[0]?.alias ?? "";
        setChatModelAlias(pick);
        chatModelRef.current = pick;
      })
      .catch(() => {
        /* offline / serve down — the picker just stays empty (server uses its default) */
      });
    return () => {
      alive = false;
    };
  }, [id]);
  const pickChatModel = (alias: string) => {
    setChatModelAlias(alias);
    chatModelRef.current = alias;
    toast.success(`Chat model set to ${alias}`);
    try {
      window.localStorage.setItem(`leash-model-${id}`, alias);
    } catch {
      /* private mode — the ref still drives this session */
    }
  };

  const { messages, sendMessage, setMessages, status, error, regenerate, stop, addToolApprovalResponse } = useChat<LeashUIMessage>({
    id,
    messages: initialMessages,
    // Tool approvals ("Ask first" tools): once every approval card on the last assistant
    // message has an answer, resend it automatically so the run continues server-side.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: new DefaultChatTransport({
      api: "/api/leash/chat",
      // Send only the last message + trigger; the server rebuilds history from the store.
      prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => {
        const plan = planModeRef.current;
        const model = chatModelRef.current || undefined; // user-chosen chat model (input picker)
        if (trigger === "regenerate-message") return { body: { id, trigger, messageId, plan, model } };
        // `voice: true` (set by the call overlay via sendMessage's body option) routes this turn
        // to the chat route's fast path (/no_think + 2-step tools). Text composer sends no body.
        const voice = (body as { voice?: boolean } | undefined)?.voice ?? false;
        return { body: { id, trigger: "submit-message", message: messages[messages.length - 1], voice, plan, model } };
      },
    }),
    experimental_throttle: 50,
    onData: (part) => {
      if (part.type !== "data-elicitation") return;
      const ev = part.data as LeashElicitationEvent;
      if (ev.kind === "open") toast.info("Input requested");
      setElicitations((prev) => (ev.kind === "open" ? [...prev.filter((e) => e.id !== ev.elicitation.id), ev.elicitation] : prev.filter((e) => e.id !== ev.id)));
    },
    onError: (e) => {
      console.error("Leash chat error:", e);
      toast.error(friendlyChatError(e));
    },
  });
  const busy = status === "submitted" || status === "streaming";

  // Context-window meter: each turn re-sends the whole thread, so the most recent assistant
  // turn's `totalTokens` (prompt history + its completion) is the best client-side proxy for
  // how full the model's window currently is. Window = qwen3-4b's 32768 (tracks the serve's
  // ctx_size in qvac.config.base.json). No cost — it's all on-device.
  const CONTEXT_WINDOW = 32768;
  const usedTokens = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant" && m.metadata?.totalTokens) return m.metadata.totalTokens;
    }
    return 0;
  })();

  // Pending indicator (AI Elements Loader): `status === "submitted"` alone is not
  // enough here — the route emits its `start` part immediately, flipping status to
  // "streaming" while the on-device serve is still PREFILLING (10-30 s with zero
  // visible output). So: show the loader while busy AND the assistant hasn't rendered
  // anything yet (no non-empty text/reasoning part, no tool part); it disappears the
  // moment the first real part lands.
  const last = messages[messages.length - 1];
  const lastAssistantParts = ((last?.parts as any[]) ?? []) as Part[];
  // Show the pending loader while busy AND the streaming assistant message has nothing
  // visible yet (no non-empty text/reasoning, no tool, no skill). A bare `step-start`
  // doesn't count — the loader stays until a real part lands, then an in-timeline active
  // node takes over.
  const assistantVisible =
    last?.role === "assistant" &&
    lastAssistantParts.some((p) => ((p?.type === "text" || p?.type === "reasoning") && typeof p.text === "string" && p.text.trim().length > 0) || isToolPart(p) || isSkillPart(p) || isConductorPart(p));
  const awaitingModel = busy && !assistantVisible;
  // Prompt queue — on a slow on-device model, let the user stack follow-ups WHILE a turn is
  // generating; they auto-send one at a time as each turn finishes (drained below). Each carries
  // its (already PNG-normalized) files so a queued image turn still routes to the vision model.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [queued, setQueued] = useState<Array<{ id: string; text: string; files?: any[] }>>([]);
  const drainingRef = useRef(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ask = async (text: string, files?: any[]) => {
    const t = text.trim();
    // Re-encode non-PNG/JPEG images (e.g. webp) to PNG — the vision model can't decode them.
    const norm = files && files.length ? await normalizeImageFiles(files) : undefined;
    if (!t && !(norm && norm.length)) return;
    if (busy) {
      // Mid-generation: queue it (visible), and ask the running turn to YIELD at its next step
      // boundary so this follow-up sends as a normal turn sooner instead of waiting for the whole
      // multi-step turn to finish. The drain effect (on idle) actually sends it.
      setQueued((q) => [...q, { id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${q.length}`, text: t, ...(norm && norm.length ? { files: norm } : {}) }]);
      toast.info("Message queued");
      void fetch("/api/leash/chat/interject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => toast.error("Couldn't ask the running turn to yield"));
      return;
    }
    void sendMessage({ text: t, ...(norm && norm.length ? { files: norm } : {}) });
  };

  // Drain the queue when the current turn finishes: send ALL queued follow-ups as a SINGLE normal
  // chat message (text joined by blank lines, any images combined) — one visible turn, one reply.
  // The ref guards the gap between sendMessage and the async status flip so we never double-send.
  useEffect(() => {
    if (status === "ready" && queued.length > 0 && !drainingRef.current) {
      drainingRef.current = true;
      const all = queued;
      setQueued([]);
      const text = all.map((q) => q.text).filter(Boolean).join("\n");
      const files = all.flatMap((q) => q.files ?? []);
      void sendMessage({ text, ...(files.length ? { files } : {}) });
    } else if (status !== "ready") {
      drainingRef.current = false;
    }
  }, [status, queued, sendMessage]);

  // Checkpoint revert: drop this turn and everything after it (keep `index` messages), both
  // client-side (setMessages) and in the store (so the transport's rebuilt history matches).
  // Destructive — guarded by a confirm and only offered when idle.
  const restoreTo = async (index: number) => {
    if (busy) return;
    if (!(await appConfirm("Restore to here? This permanently deletes this turn and everything after it.", { confirmLabel: "Restore", destructive: true }))) return;
    setMessages(messages.slice(0, index));
    try {
      const res = await fetch(`/api/leash/chats/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keep: index }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Conversation restored");
    } catch {
      toast.error("Conversation restored locally; store update failed");
    }
  };

  return (
    <TooltipProvider>
      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-[760px]">
          {messages.length === 0 ? (
            <ConversationEmptyState title="Ask Leash anything." description="Grounded in your private notes and The Understory — all on-device.">
              <p className="chat-empty-title">Ask Leash anything.</p>
              <p className="chat-empty-sub">Grounded in your private notes and The Understory — all on-device. Home &amp; Activity arrive once configured.</p>
              <Suggestions className="mt-6 justify-center">
                {SUGGESTIONS.map((s) => (
                  <Suggestion key={s} suggestion={s} onClick={(text) => ask(text)} />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          ) : (
            messages.map((m, idx) => (
              <Fragment key={m.id}>
                {/* Checkpoint restore point — before each user turn after the first, when idle.
                    Restoring truncates the conversation to just before this turn. */}
                {m.role === "user" && idx > 0 && status === "ready" && (
                  <Checkpoint className="chat-checkpoint">
                    <CheckpointIcon />
                    <CheckpointTrigger tooltip="Restore the conversation to just before this turn (deletes later turns)" onClick={() => void restoreTo(idx)}>
                      Restore to here
                    </CheckpointTrigger>
                  </Checkpoint>
                )}
                <MessageView
                  message={m}
                  streaming={busy}
                  live={busy && idx === messages.length - 1}
                  onRegenerate={!busy ? () => { toast.info("Regenerating answer"); regenerate({ messageId: m.id }); } : undefined}
                  chatId={id}
                  prompt={precedingUserText(messages, idx)}
                  // Approval cards are actionable only on the LAST message of an idle chat —
                  // historical cards render as inert chips.
                  approval={idx === messages.length - 1 && status === "ready" ? { respond: addToolApprovalResponse } : undefined}
                />
              </Fragment>
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
              <button type="button" onClick={() => { toast.info("Retrying answer"); regenerate(); }}>
                Retry
              </button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="chat-composer">
        {/* Prompt queue — follow-ups you sent while the model was busy, auto-sent one at a time. */}
        {queued.length > 0 && (
          <Queue className="chat-queue mx-auto max-w-[760px]">
            <QueueSection>
              <QueueSectionTrigger>
                <QueueSectionLabel count={queued.length} label={queued.length === 1 ? "queued message" : "queued messages"} icon={<ClockIcon className="size-4" />} />
              </QueueSectionTrigger>
              <QueueSectionContent>
                <QueueList>
                  {queued.map((q) => (
                    <QueueItem key={q.id}>
                      <div className="flex items-start gap-2">
                        <QueueItemContent className="!line-clamp-2 whitespace-normal">{q.text || "(image)"}</QueueItemContent>
                        <QueueItemActions>
                          <QueueItemAction aria-label="Remove from queue" onClick={() => { setQueued((qq) => qq.filter((x) => x.id !== q.id)); toast.info("Queued message removed"); }}>
                            <XIcon className="size-3.5" />
                          </QueueItemAction>
                        </QueueItemActions>
                      </div>
                    </QueueItem>
                  ))}
                </QueueList>
              </QueueSectionContent>
            </QueueSection>
          </Queue>
        )}
        {/* Provider gives us a controller (for the mic to drop text into the box) + shared attachments. */}
        <PromptInputProvider>
          <PromptInput className="chat-composer-inner mx-auto max-w-[760px]" onError={(e) => toast.error(e.message)} onSubmit={(message) => ask(message.text ?? "", message.files)}>
            <PromptInputBody>
              {/* Visible thumbnails / chips of attached files (with remove). */}
              <ComposerAttachments />
              <PromptInputTextarea placeholder="Ask about your notes, your paper, or attach a file…" />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                {/* Attach a file → an image routes the turn to the vision model; any other file
                    (markdown, code, JSON, CSV, logs…) is read as text into the chat model. */}
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="Attach a file" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                {/* 🎙 Voice input → on-device transcription → text dropped into the box to review/send. */}
                <MicButton disabled={busy} />
                {/* 📞 Call → hands-free, audio-only voice loop over the SAME conversation. Icon-only, label on hover. */}
                <button
                  type="button"
                  onClick={() => { setCallOpen(true); toast.info("Voice call starting"); }}
                  aria-label="Call — hands-free voice mode"
                  title="Call — hands-free voice mode"
                  className="chat-mic chat-icon-btn"
                >
                  <PhoneIcon className="size-4" />
                </button>
                {/* Plan mode toggle — when on, the assistant drafts a plan you approve before it runs. Icon-only, label on hover. */}
                <button
                  type="button"
                  onClick={togglePlanMode}
                  aria-pressed={planMode}
                  aria-label={planMode ? "Plan mode on" : "Plan mode off"}
                  title={planMode ? "Plan mode ON — the assistant plans, you approve, then it runs each step" : "Plan mode OFF — turn on to plan-then-approve before acting"}
                  className={`chat-mic chat-icon-btn chat-plan-btn${planMode ? " is-on" : ""}`}
                >
                  <ListChecksIcon className="size-4" />
                </button>
                {/* Model picker — choose which configured model drives this conversation (per-turn,
                    persisted per chat). Empty list = serve down / nothing configured. */}
                {chatModels.length > 0 ? (
                  <select
                    value={chatModelAlias}
                    onChange={(e) => pickChatModel(e.target.value)}
                    aria-label="Chat model"
                    title="Chat model for this conversation"
                    className="chat-mic chat-icon-btn"
                    style={{ width: "auto", padding: "0 0.5rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}
                  >
                    {chatModels.map((m) => (
                      <option key={m.alias} value={m.alias}>
                        {m.alias}
                        {m.loaded ? "" : " · load"}
                      </option>
                    ))}
                  </select>
                ) : (
                  // No CHAT model configured (e.g. only an mmproj/embedding present) — point the user
                  // at where to fix it instead of silently offering nothing.
                  <a
                    href="/brain?tab=models"
                    title="No chat model configured — add one in Brain → Models"
                    className="chat-mic chat-icon-btn"
                    style={{ width: "auto", padding: "0 0.5rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-brick)" }}
                  >
                    no chat model · add ↗
                  </a>
                )}
                {/* Context-window meter (on-device, no cost) — shows how full the model's 32k
                    window is, from the latest turn's token count. */}
                {usedTokens > 0 && (
                  <Context maxTokens={CONTEXT_WINDOW} usedTokens={usedTokens}>
                    <ContextTrigger className="chat-context" />
                    <ContextContent>
                      <ContextContentHeader />
                      <ContextContentBody>
                        <p className="text-muted-foreground text-xs">On-device · {chatModelAlias || "default"} · no API cost</p>
                      </ContextContentBody>
                    </ContextContent>
                  </Context>
                )}
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

/** The text of the user message immediately preceding index `idx` (for feedback pairing). */
function precedingUserText(messages: LeashUIMessage[], idx: number): string {
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      return (m.parts as Part[]).filter((p: Part) => p.type === "text").map((p: Part) => p.text ?? "").join(" ").trim();
    }
  }
  return "";
}

function MessageView({ message, streaming, live, onRegenerate, approval, chatId, prompt }: { message: LeashUIMessage; streaming: boolean; live?: boolean; onRegenerate?: () => void; approval?: ApprovalHandle; chatId?: string; prompt?: string }) {
  const { role } = message;
  const parts = message.parts as Part[];
  // Read-aloud is a small state machine: idle → loading (synthesizing) → playing → idle.
  // Clicking while loading/playing cancels (aborts the fetch / stops playback). Failures
  // surface an inline, actionable message instead of silently resetting.
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">("idle");
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The ChainOfThought timeline: open while this message streams, auto-collapse ~1.2s after
  // it finishes (mirrors the Reasoning element's auto-close). Historical messages start closed.
  const [cotOpen, setCotOpen] = useState(!!live);
  useEffect(() => {
    if (live) {
      setCotOpen(true);
      return;
    }
    const t = setTimeout(() => setCotOpen(false), 1200);
    return () => clearTimeout(t);
  }, [live]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Stop/cancel any in-flight synthesis or playback and return to idle. */
  const stopSpeak = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    setTtsState("idle");
    toast.info("Read aloud stopped");
  };

  /** On-device read-aloud of the answer text via /api/leash/speak (supertonic TTS). */
  const speak = async (text: string) => {
    if (ttsState !== "idle") {
      stopSpeak(); // toggle: cancel synthesis or stop playback
      return;
    }
    if (!text.trim()) return;
    toast.info("Synthesizing speech…");
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
      toast.success("Read aloud playing");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setTtsState("idle"); // user cancelled — not an error
        return;
      }
      const msg = err instanceof Error ? err.message : "Read aloud failed.";
      setTtsError(msg);
      toast.error(msg);
      setTtsState("idle");
    }
  };

  /** Copy the answer text to the clipboard (with a brief ✓ confirmation). */
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Answer copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy answer");
    }
  };

  if (role === "user") {
    const text = parts.filter((p: Part) => p.type === "text").map((p: Part) => p.text ?? "").join("");
    const fileParts = parts.filter((p: Part) => p.type === "file" && typeof p.url === "string");
    const images = fileParts.filter((p: Part) => String(p.mediaType ?? "").startsWith("image/"));
    const files = fileParts.filter((p: Part) => !String(p.mediaType ?? "").startsWith("image/"));
    return (
      <Message from="user">
        <MessageContent>
          {images.map((p: Part, i: number) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={`img-${i}`} src={p.url} alt={p.filename ?? "attachment"} className="chat-attached-img" />
          ))}
          {files.length > 0 && (
            <div className="chat-attached-files">
              {files.map((p: Part, i: number) => (
                <a key={`file-${i}`} href={p.url} download={p.filename ?? "file"} className="chat-attached-file" title={`${p.filename ?? "file"} — download`}>
                  <PaperclipIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{p.filename ?? "file"}</span>
                </a>
              ))}
            </div>
          )}
          {/* Preserve line breaks — a combined-queue message puts each follow-up on its own line. */}
          <span className="whitespace-pre-wrap">{text}</span>
        </MessageContent>
      </Message>
    );
  }

  const meta = telemetry(message.metadata);
  const isLive = !!live;
  const { nodes, answer } = buildTimeline(parts);
  const answerText = answer;
  const sources = collectSources(parts);
  // While streaming with no answer yet and the last node isn't already showing an active
  // affordance, append a "Thinking…" node so the spine has a live tail (the pending step).
  const showPending = isLive && !answerText.trim() && !lastNodeActive(nodes, isLive);
  // Keep the timeline open whenever an approval is actionable on it — auto-collapse would
  // otherwise hide the Approve/Deny buttons on the last idle message.
  const hasPendingApproval = nodes.some((n) => n.kind === "tool" && n.part.state === "approval-requested");
  const timelineOpen = cotOpen || hasPendingApproval;

  return (
    <Message from="assistant">
      <MessageContent>
        {nodes.length > 0 && (
          <ChainOfThought className="my-1" open={timelineOpen} onOpenChange={setCotOpen}>
            <ChainOfThoughtHeader>{isLive ? <Shimmer duration={1.4}>Working…</Shimmer> : `Worked through ${nodes.length} step${nodes.length === 1 ? "" : "s"}`}</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              {nodes.map((n) => renderTimelineNode(n, isLive, approval))}
              {showPending && <ChainOfThoughtStep icon={DotIcon} status="active" label={<Shimmer as="span" duration={1.2}>Thinking…</Shimmer>} />}
            </ChainOfThoughtContent>
          </ChainOfThought>
        )}

        {answerText.trim() && <CitedAnswer text={answerText} sources={sources} />}

        {/* RAG grounding aggregated from this message's tool outputs (notes / paper). */}
        {sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((s, i) => (
                <Source key={i} href={s.url ?? undefined} title={s.title} />
              ))}
            </SourcesContent>
          </Sources>
        )}

        <div className="chat-foot">
          {meta && <span className="chat-meta">{meta}</span>}
          {answerText.trim() && (
            <MessageActions>
              <MessageAction
                tooltip={ttsState === "loading" ? "Synthesizing… click to cancel" : ttsState === "playing" ? "Stop" : "Read aloud (on-device TTS)"}
                onClick={() => void speak(answerText)}
                className={ttsError ? "text-[color:var(--color-brick)]" : ttsState !== "idle" ? "text-[color:var(--color-sage-deep)]" : undefined}
              >
                {ttsState === "loading" ? <Loader size={14} /> : ttsState === "playing" ? <SquareIcon className="size-4" /> : <Volume2Icon className="size-4" />}
              </MessageAction>
              <MessageAction tooltip={copied ? "Copied" : "Copy answer"} onClick={() => void copy(answerText)}>
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              </MessageAction>
              {onRegenerate && (
                <MessageAction tooltip="Regenerate" onClick={onRegenerate}>
                  <RefreshCcwIcon className="size-4" />
                </MessageAction>
              )}
            </MessageActions>
          )}
          {ttsError && (
            <span className="chat-tts-err" role="status" title={ttsError}>
              ⚠ {ttsError}
            </span>
          )}
          {/* Layer-4 feedback: 👍/👎 (+ correction) → data/leash-feedback.jsonl for the
              nightly LoRA. Separate fetch — never touches the streaming/useChat path. */}
          {answerText.trim() && !streaming && <MessageFeedback messageId={message.id} chatId={chatId} prompt={prompt ?? ""} answer={answerText} />}
        </div>
      </MessageContent>
    </Message>
  );
}
