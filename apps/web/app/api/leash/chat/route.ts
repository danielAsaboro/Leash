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
import { streamText, convertToModelMessages, stepCountIs, validateUIMessages, createIdGenerator } from "ai";
import { z } from "zod";
import { chatModel, medpsyModel, visionModel, CHAT_MODEL, MEDPSY_MODEL, VISION_MODEL } from "../../../../lib/leash/provider.ts";
import { leashTools, LEASH_SYSTEM, LEASH_VOICE_DIRECTIVE } from "../../../../lib/leash/tools.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { loadChat, saveChat } from "../../../../lib/leash/chat-store.ts";
import { classifyEffort, effortConfig } from "../../../../lib/leash/effort.ts";
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

const MEDPSY_SYSTEM =
  LEASH_SYSTEM +
  " The current question is health/medical/wellbeing-related: you are MedPsy, an on-device medical assistant. " +
  "Be accurate and concise, ground in the tools when relevant, and add a brief 'not a substitute for a clinician' caveat.";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { id: string; trigger?: string; messageId?: string; message?: LeashUIMessage; voice?: boolean };
  const { id, trigger, messageId, message, voice } = body;

  const tools = { ...leashTools, ...(await leashMcpTools()) };

  // Rebuild the working history from the store + the incoming trigger.
  const previous = await loadChat(id);
  let messages: LeashUIMessage[];
  if (trigger === "regenerate-message" && messageId) {
    const idx = previous.findIndex((m) => m.id === messageId);
    messages = idx === -1 ? previous : previous.slice(0, idx); // drop the assistant msg → regenerate
  } else {
    messages = message ? [...previous, message] : previous; // submit-message
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
  const baseSystem = health ? MEDPSY_SYSTEM : LEASH_SYSTEM;
  const useNoThink = !!cfg?.noThink;

  // On voice turns (non-image), append the spoken-output directive so the model answers in short,
  // markdown-free prose — Supertonic reads raw markdown literally. Text and image turns are unchanged.
  const system = [baseSystem, voice && !imageTurn ? LEASH_VOICE_DIRECTIVE : "", useNoThink ? "/no_think" : ""]
    .filter(Boolean)
    .join(" ");

  const result = streamText({
    model: imageTurn ? visionModel() : health ? medpsyModel() : chatModel(),
    system,
    // DELIBERATELY no `abortSignal: req.signal` — the qvac serve WEDGES its LLM decode loop if the
    // client disconnects mid-generation (verified 2026-06-05: one aborted request → every later
    // generation hangs at zero tokens until the serve restarts; upstream SDK bug). So on a voice
    // barge-in / stop, the abandoned generation runs to completion server-side (bounded by the
    // tier's maxOutputTokens) and the next turn queues briefly behind it — slow beats dead.
    messages: await convertToModelMessages(validated),
    // VLMs handle one image-grounded turn; tools/multi-step only on the text models.
    ...(imageTurn || !cfg
      ? {}
      : { ...(cfg.tools ? { tools } : {}), stopWhen: stepCountIs(cfg.steps), maxOutputTokens: cfg.maxOutputTokens }),
  });

  // Persist even if the client disconnects mid-stream (and keep the serve connection open until the
  // generation completes — see the no-abortSignal note above).
  void result.consumeStream();

  return result.toUIMessageStreamResponse({
    originalMessages: validated,
    sendReasoning: true,
    generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
    messageMetadata: ({ part }) => {
      if (part.type === "start") return { createdAt: Date.now(), model: activeModel, ...(tier ? { effort: tier } : {}) };
      if (part.type === "finish") return { finishedAt: Date.now(), totalTokens: part.totalUsage?.totalTokens };
    },
    onFinish: ({ messages: finalMessages }) => {
      void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}
