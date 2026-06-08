/**
 * `POST /api/leash/feedback` — record a 👍/👎 (+ optional correction) on an assistant
 * answer. Appends to `data/leash-feedback.jsonl`, which the nightly LoRA curates:
 *   👍 → a positive pair · 👎+correction → the correction is the target · 👎 → the
 *   bad pair is excluded from training.
 *
 * Deliberately tiny and side-effect-free w.r.t. the chat: the client POSTs this from a
 * SEPARATE fetch, never touching the streaming/useChat path (the house no-abort taboo).
 */
import { appendFeedback } from "../../../../lib/leash/feedback-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: {
    messageId?: string;
    chatId?: string;
    rating?: string;
    prompt?: string;
    answer?: string;
    correction?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const rating = body.rating;
  if (rating !== "up" && rating !== "down") {
    return Response.json({ error: "rating must be 'up' or 'down'" }, { status: 400 });
  }
  if (typeof body.messageId !== "string" || !body.messageId) {
    return Response.json({ error: "messageId required" }, { status: 400 });
  }

  appendFeedback({
    messageId: body.messageId,
    chatId: typeof body.chatId === "string" ? body.chatId : undefined,
    rating,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    answer: typeof body.answer === "string" ? body.answer : "",
    correction: typeof body.correction === "string" ? body.correction : undefined,
  });
  return Response.json({ ok: true });
}
