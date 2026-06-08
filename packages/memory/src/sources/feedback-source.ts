/**
 * Source: web feedback (`data/leash-feedback.jsonl`), the spec's "user
 * corrections/ratings". Highest dedupe priority — an explicit human signal.
 *
 *   👍            → a positive pair (this answer was good).
 *   👎 + correction → the CORRECTION becomes the target answer.
 *   👎 alone       → no pair; the matching prompt is EXCLUDED (we won't train the
 *                    rejected answer back in via the chat source).
 */
import { existsSync, readFileSync } from "node:fs";
import type { FeedbackRecord, TrainingPair } from "../types.ts";
import { FEEDBACK_FILE } from "../paths.ts";
import { normalizePrompt } from "../text.ts";

export function readFeedback(file: string = FEEDBACK_FILE): FeedbackRecord[] {
  if (!existsSync(file)) return [];
  const out: FeedbackRecord[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as FeedbackRecord;
      if (rec && (rec.rating === "up" || rec.rating === "down") && typeof rec.prompt === "string") {
        out.push(rec);
      }
    } catch {
      // skip malformed line — lenient reader
    }
  }
  return out;
}

export interface FeedbackPairs {
  pairs: TrainingPair[];
  /** Normalized prompts whose chat pair must be dropped (👎 with no correction). */
  exclude: Set<string>;
}

export function readFeedbackPairs(file: string = FEEDBACK_FILE): FeedbackPairs {
  const pairs: TrainingPair[] = [];
  const exclude = new Set<string>();
  for (const rec of readFeedback(file)) {
    const prompt = rec.prompt.trim();
    if (prompt.length < 5) continue;
    if (rec.rating === "up") {
      const answer = (rec.answer ?? "").trim();
      if (answer.length >= 12) pairs.push({ prompt, answer, source: "feedback", ref: rec.messageId });
    } else {
      const correction = (rec.correction ?? "").trim();
      if (correction.length >= 12) {
        pairs.push({ prompt, answer: correction, source: "feedback", ref: rec.messageId });
      } else {
        exclude.add(normalizePrompt(prompt)); // 👎 with no fix → drop the bad pair
      }
    }
  }
  return { pairs, exclude };
}
