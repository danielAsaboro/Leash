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
import { leashTools, LEASH_SYSTEM } from "../../../../lib/leash/tools.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { loadChat, saveChat } from "../../../../lib/leash/chat-store.ts";
import type { LeashUIMessage } from "../../../../lib/leash/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const metadataSchema = z.object({
  createdAt: z.number().optional(),
  finishedAt: z.number().optional(),
  model: z.string().optional(),
  totalTokens: z.number().optional(),
});

/** P4 specialist routing: health/medical/mental-health intent → the MedPsy specialist. */
const HEALTH_RE =
  /\b(symptom|diagnos|treatment|medicat|dosage|dose|prescri|disease|illness|infection|fever|nausea|migraine|asthma|diabet|pneumonia|antibiotic|blood ?pressure|cholesterol|doctor|physician|clinic|therap|anxiet|depress|mental health|insomnia|panic|trauma|psych|wellbeing|well-being)\w*/i;
function isHealthIntent(messages: LeashUIMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = ((lastUser?.parts as any[]) ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ");
  return HEALTH_RE.test(text);
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

  // Voice ("call") fast path: a spoken turn must answer in seconds, not ~100s. Disable Qwen3's
  // `<think>` reasoning (the `/no_think` soft-switch) and cap the tool loop to 2 steps. The text
  // chat is untouched — it keeps full reasoning + the 6-step tool loop.
  const noThink = !!voice && !imageTurn;
  const baseSystem = health ? MEDPSY_SYSTEM : LEASH_SYSTEM;

  const result = streamText({
    model: imageTurn ? visionModel() : health ? medpsyModel() : chatModel(),
    system: noThink ? `${baseSystem} /no_think` : baseSystem,
    messages: await convertToModelMessages(validated),
    // VLMs handle one image-grounded turn; tools/multi-step only on the text models.
    ...(imageTurn ? {} : { tools, stopWhen: stepCountIs(noThink ? 2 : 6) }),
  });

  // Persist even if the client disconnects mid-stream.
  void result.consumeStream();

  return result.toUIMessageStreamResponse({
    originalMessages: validated,
    sendReasoning: true,
    generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
    messageMetadata: ({ part }) => {
      if (part.type === "start") return { createdAt: Date.now(), model: activeModel };
      if (part.type === "finish") return { finishedAt: Date.now(), totalTokens: part.totalUsage?.totalTokens };
    },
    onFinish: ({ messages: finalMessages }) => {
      void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}
