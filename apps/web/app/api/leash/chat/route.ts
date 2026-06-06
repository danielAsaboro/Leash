/**
 * `POST /api/leash/chat` — the Leash assistant (Vercel AI SDK), with persistence.
 *
 * The client sends only the **last** message + the chat `id` + a `trigger`
 * (`prepareSendMessagesRequest`), so we rebuild history from the store:
 *   · submit-user-message      → append the new user message
 *   · regenerate-assistant-message → drop the target assistant message, re-run
 * We validate the stored+new messages against current tool/metadata schemas, stream the
 * on-device tool loop, persist the full thread in `onFinish`, and `consumeStream()` so a
 * client disconnect still saves. Server-side message IDs keep stored threads stable —
 * which the future "dreaming"/consolidation pass relies on.
 */
import { streamText, convertToModelMessages, stepCountIs, validateUIMessages, createIdGenerator, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { chatModel, medpsyModel, visionModel, CHAT_MODEL, MEDPSY_MODEL, VISION_MODEL } from "../../../../lib/leash/provider.ts";
import { leashTools } from "../../../../lib/leash/tools.ts";
import { taskTools } from "../../../../lib/leash/task-tools.ts";
import { memoryTools } from "../../../../lib/leash/memory-tools.ts";
import { preferenceTexts } from "../../../../lib/leash/memories-store.ts";
import { skillTools, skillsSystemSection } from "../../../../lib/leash/skill-tools.ts";
import { researchTools } from "../../../../lib/leash/research-tools.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { getPrompt } from "../../../../lib/leash/prompts-store.ts";
import { filterEnabledTools, disabledTools, withApprovalGates } from "../../../../lib/leash/tool-config.ts";
import { repairLeashToolCall } from "../../../../lib/leash/json-repair.ts";
import { loadRecord, saveChat } from "../../../../lib/leash/chat-store.ts";
import { compact } from "../../../../lib/leash/compactor.ts";
import { classifyEffort, effortConfig } from "../../../../lib/leash/effort.ts";
import { beginGeneration } from "../../../../lib/leash/inflight.ts";
import { subscribeElicitations } from "../../../../lib/leash/elicitations.ts";
import type { LeashUIMessage } from "../../../../lib/leash/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// `.optional()` on the OBJECT: user messages carry no metadata at all (only assistant messages get
// it via `messageMetadata`), so the schema must accept `undefined` or validation fails on every
// stored thread and falls back to raw history.
const metadataSchema = z
  .object({
    createdAt: z.number().optional(),
    finishedAt: z.number().optional(),
    model: z.string().optional(),
    totalTokens: z.number().optional(),
    effort: z.enum(["quick", "standard", "deep"]).optional(),
  })
  .optional();

/** The text-parts join of the most recent user message (intent classifiers + effort grading). */
function lastUserText(messages: LeashUIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ");
}

/** P4 specialist routing: health/medical/mental-health intent → the MedPsy specialist. */
const HEALTH_RE =
  /\b(symptom|diagnos|treatment|medicat|dosage|dose|prescri|disease|illness|infection|fever|nausea|migraine|asthma|diabet|pneumonia|antibiotic|blood ?pressure|cholesterol|doctor|physician|clinic|therap|anxiet|depress|mental health|insomnia|panic|trauma|psych|wellbeing|well-being)\w*/i;
function isHealthIntent(messages: LeashUIMessage[]): boolean {
  return HEALTH_RE.test(lastUserText(messages));
}

/** Vision routing: the latest user message carries an image (file part) → use the VLM. */
function isImageTurn(messages: LeashUIMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).some((p) => p?.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { id: string; trigger?: string; messageId?: string; message?: LeashUIMessage; voice?: boolean };
  const { id, trigger, messageId, message, voice } = body;

  // Task/memory tools are per-request factories: writes get stamped with this chat's id.
  // This is the FULL registry — used for message validation; `streamText` gets the filtered set.
  const tools = { ...leashTools, ...taskTools(id), ...memoryTools(id), ...skillTools, ...researchTools, ...(await leashMcpTools()) };

  // Rebuild the working history from the store + the incoming trigger.
  const record = await loadRecord(id);
  const previous = record?.messages ?? [];
  let messages: LeashUIMessage[];
  if (trigger === "regenerate-message" && messageId) {
    const idx = previous.findIndex((m) => m.id === messageId);
    messages = idx === -1 ? previous : previous.slice(0, idx); // drop the assistant msg → regenerate
  } else if (message) {
    // REPLACE-BY-ID, not append: a tool-approval response mutates the LAST ASSISTANT
    // message in place client-side and resends it under the SAME id — appending would
    // duplicate it in the stored thread. A normal user submit has a fresh id (i === -1)
    // and still appends.
    const i = previous.findIndex((m) => m.id === message.id);
    messages = i === -1 ? [...previous, message] : [...previous.slice(0, i), message, ...previous.slice(i + 1)];
  } else {
    messages = previous;
  }

  // Validate stored+new messages against current tool/metadata schemas; fall back to raw on drift.
  let validated: LeashUIMessage[] = messages;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validated = (await validateUIMessages({ messages, tools: tools as any, metadataSchema })) as LeashUIMessage[];
  } catch (err) {
    console.error("leash: UI message validation failed, using raw history:", err);
  }

  // Routing: image turn → vision VLM; else medical/wellbeing → MedPsy specialist; else generalist.
  const imageTurn = isImageTurn(validated);
  const health = !imageTurn && isHealthIntent(validated);
  const activeModel = imageTurn ? VISION_MODEL : health ? MEDPSY_MODEL : CHAT_MODEL;

  // Dynamic effort: grade each non-image turn (text + voice) into a tier and derive its params
  // (tools on/off, step cap, `/no_think`, token ceiling). A spoken turn must answer in seconds,
  // so voice always runs `/no_think`; text keeps full `<think>` reasoning on the `deep` tier.
  // Image turns are unchanged (the VLM handles one image-grounded turn, no tools/no /no_think).
  const tier = imageTurn ? null : await classifyEffort(lastUserText(validated));
  const cfg = tier ? effortConfig(tier, !!voice) : null;
  const useNoThink = !!cfg?.noThink;

  // Prompts come from the store (dashboard override ?? code default; mtime-cached reads),
  // plus the skills section ("" when no skills — honest empty state).
  const [systemPrompt, skillsSection, prefs] = await Promise.all([getPrompt("system"), skillsSystemSection(), preferenceTexts()]);
  const baseSystem = health ? systemPrompt + (await getPrompt("medpsy")) : systemPrompt;
  // `preference` memories steer behavior on EVERY turn (other memory types are
  // retrieval-only via recall/search_graph). Bounded: newest 20.
  const prefSection = prefs.length ? "Saved user preferences — follow them: " + prefs.slice(0, 20).map((p) => `· ${p}`).join(" ") : "";

  // Tool toggles apply at streamText (not at validation): old threads must still
  // validate against the full registry even when a tool they used is now disabled.
  // Approval gates ("Ask first") read config at call time — a toggle applies next turn.
  const enabledTools = withApprovalGates(await filterEnabledTools(tools));
  // The (possibly overridden) system prompt may still NAME disabled tools — tell the
  // model they're gone, or it text-hallucinates <tool_call> blocks for them.
  const off = await disabledTools();
  const disabledNote = off.size > 0 ? `The following tools are DISABLED and unavailable right now — do not attempt to call them: ${[...off].join(", ")}.` : "";
  // Some tool calls pause on a human approval card. A DENIED call must not be retried —
  // acknowledge the refusal and move on (without this, small models loop the same call).
  const approvalNote =
    "Some tool calls require the user's approval before running. If the user denies a tool call, do NOT retry it — acknowledge that it was declined and continue without it.";

  // Context compaction (text turns only): when the thread outgrows the model's window,
  // summarize the oldest messages into a stored running summary and send only
  // [summary + recent tail] to the model. The FULL history stays in `validated` →
  // `originalMessages` → saved/displayed; only the model's input shrinks. Image turns
  // are single-shot, so they skip this. Best-effort: failure falls back to full history.
  const CTX = Number(process.env["LEASH_CHAT_CTX"] ?? 4096);
  let modelMessages = validated;
  let summarySection = "";
  if (!imageTurn) {
    const c = await compact(id, validated, CTX, { summary: record?.summary, summarizedThrough: record?.summarizedThrough });
    if (c.tailFrom > 0 && c.tailFrom < validated.length) modelMessages = validated.slice(c.tailFrom);
    if (c.summary) summarySection = `Earlier in this conversation (summary of ${c.tailFrom} prior message${c.tailFrom === 1 ? "" : "s"}): ${c.summary}`;
  }

  // On voice turns (non-image), append the spoken-output directive so the model answers in short,
  // markdown-free prose — Supertonic reads raw markdown literally. Text and image turns are unchanged.
  const system = [baseSystem, summarySection, prefSection, skillsSection, disabledNote, approvalNote, voice && !imageTurn ? await getPrompt("voice") : "", useNoThink ? "/no_think" : ""]
    .filter(Boolean)
    .join(" ");

  // Count this generation as in-flight so the dashboard's serve stop/restart refuses
  // while the serve is decoding (aborting/killing mid-generation wedges the GPU).
  const release = beginGeneration();

  const result = streamText({
    model: imageTurn ? visionModel() : health ? medpsyModel() : chatModel(),
    system,
    // DELIBERATELY no `abortSignal: req.signal` — the qvac serve WEDGES its LLM decode loop if the
    // client disconnects mid-generation (verified 2026-06-05: one aborted request → every later
    // generation hangs at zero tokens until the serve restarts; upstream SDK bug). So on a voice
    // barge-in / stop, the abandoned generation runs to completion server-side (bounded by the
    // tier's maxOutputTokens) and the next turn queues briefly behind it — slow beats dead.
    // Compacted for the model (summary + recent tail); the full thread is still saved
    // via `originalMessages: validated` below.
    messages: await convertToModelMessages(modelMessages),
    // VLMs handle one image-grounded turn; tools/multi-step only on the text models.
    ...(imageTurn || !cfg
      ? {}
      : {
          ...(cfg.tools ? { tools: enabledTools, experimental_repairToolCall: repairLeashToolCall } : {}),
          stopWhen: stepCountIs(cfg.steps),
          maxOutputTokens: cfg.maxOutputTokens,
        }),
  });

  // Persist even if the client disconnects mid-stream (and keep the serve connection open until the
  // generation completes — see the no-abortSignal note above). `then(release, release)` is the one
  // signal that ALWAYS fires once the serve is done decoding (success, error, or abandoned client).
  void result.consumeStream().then(release, release);

  // Wrap the model stream so out-of-band MCP elicitation events (server→user forms, see
  // elicitations.ts) ride this same SSE response as TRANSIENT data parts — they reach
  // `useChat`'s onData but are never persisted into the message. Wedge invariants are
  // unchanged: same no-abortSignal streamText above, same consumeStream→release, and
  // `originalMessages` keeps the same message-id reuse as before.
  let unsubscribe: (() => void) | undefined;
  const stream = createUIMessageStream<LeashUIMessage>({
    originalMessages: validated,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: ({ writer }) => {
      unsubscribe = subscribeElicitations((ev) => {
        try {
          writer.write({ type: "data-elicitation", data: ev, transient: true });
        } catch {
          /* stream already closed — the GET /elicitations fallback covers reloads */
        }
      });
      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          messageMetadata: ({ part }) => {
            if (part.type === "start") return { createdAt: Date.now(), model: activeModel, ...(tier ? { effort: tier } : {}) };
            if (part.type === "finish") return { finishedAt: Date.now(), totalTokens: part.totalUsage?.totalTokens };
            return undefined;
          },
          onError: (error) => {
            release();
            return error instanceof Error ? error.message : String(error);
          },
        }),
      );
    },
    onFinish: ({ messages: finalMessages }) => {
      unsubscribe?.();
      release(); // idempotent belt-and-braces alongside consumeStream().finally
      void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
