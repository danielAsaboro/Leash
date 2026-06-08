/**
 * Feedback store — the spec's "user corrections/ratings" signal for Layer 4.
 *
 * Append-only JSONL at `data/leash-feedback.jsonl`: each 👍/👎 (and any typed
 * correction) becomes one line that the nightly curation (@mycelium/memory) reads.
 * Append-only on purpose — same durable, torn-write-tolerant pattern as the audit
 * log and the activity trail.
 */
import "server-only";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data/leash-feedback.jsonl (same resolution as graph.ts). */
export const FEEDBACK_FILE = process.env["LEASH_FEEDBACK_FILE"] ?? join(here, "..", "..", "..", "..", "data", "leash-feedback.jsonl");

export interface FeedbackInput {
  messageId: string;
  chatId?: string;
  rating: "up" | "down";
  prompt: string;
  answer: string;
  correction?: string;
}

/** Append one feedback record. Returns the stored record (with ts). */
export function appendFeedback(input: FeedbackInput): { ok: true } {
  const record = {
    ts: new Date().toISOString(),
    messageId: input.messageId,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    rating: input.rating,
    prompt: input.prompt.slice(0, 4000),
    answer: input.answer.slice(0, 8000),
    ...(input.correction ? { correction: input.correction.slice(0, 4000) } : {}),
  };
  mkdirSync(dirname(FEEDBACK_FILE), { recursive: true });
  appendFileSync(FEEDBACK_FILE, JSON.stringify(record) + "\n");
  return { ok: true };
}
