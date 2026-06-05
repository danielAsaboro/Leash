/**
 * Context compaction (server-only) — keep long chats inside the model's window.
 *
 * qwen3-4b serves a 4096-token window; a long thread silently falls off the back.
 * Instead, when the history outgrows a budget we summarize the OLDEST messages into a
 * running `summary` (stored on the ChatRecord) and feed the model
 * `[summary + recent tail]`. The full message array is never touched — the user still
 * sees and the store still keeps everything; only the model's input is compacted.
 * Adapted from Odysseus `src/context_compactor.py`.
 */
import "server-only";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { chatModelBackground } from "./provider.ts";
import { saveSummary } from "./chat-store.ts";
import type { LeashUIMessage } from "./types.ts";

/** Messages always kept verbatim at the end (recent turns the model sees in full). */
const KEEP_TAIL = 6;
/** Fraction of the context window we let history occupy before compacting. */
const BUDGET_FRACTION = 0.6;

/** Plain text of a UI message (text parts joined) — for token estimation + summarizing. */
function messageText(m: LeashUIMessage): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = (m.parts as any[]) ?? [];
  const text = parts
    .filter((p) => p?.type === "text" || p?.type === "reasoning")
    .map((p) => p.text ?? "")
    .join(" ");
  return text.replace(/\s+/g, " ").trim();
}

/** Cheap token estimate (~4 chars/token). */
const estTokens = (s: string): number => Math.ceil(s.length / 4);

const inertTools = {
  noop: tool({ description: "Unused. Do NOT call this — answer directly in text.", inputSchema: z.object({}), execute: async () => ({ ignore: true }) }),
};

export interface Compaction {
  /** Running summary of everything before the tail (null when nothing compacted). */
  summary: string | null;
  /** Index into the full message array; the model sees messages.slice(from). */
  tailFrom: number;
}

/**
 * Decide + (if needed) extend the running summary so the model's input fits the budget.
 * Persists any new summary to the record. Returns what the route should feed the model.
 *
 * `prior` is the record's stored {summary, summarizedThrough}. `messages` is the FULL
 * validated history (including the new user turn).
 */
export async function compact(chatId: string, messages: LeashUIMessage[], ctxSize: number, prior: { summary?: string; summarizedThrough?: number }): Promise<Compaction> {
  const budget = Math.max(1024, ctxSize) * BUDGET_FRACTION;
  let summary = prior.summary ?? null;
  let tailFrom = Math.min(prior.summarizedThrough ?? 0, messages.length);

  // Current model-input estimate = summary + the tail we'd send.
  const tailTokens = () => messages.slice(tailFrom).reduce((n, m) => n + estTokens(messageText(m)), 0);
  const summaryTokens = () => (summary ? estTokens(summary) : 0);

  // Already within budget → use the stored summary + tail as-is (no LLM call).
  if (summaryTokens() + tailTokens() <= budget) return { summary, tailFrom };

  // Over budget: fold everything older than the last KEEP_TAIL messages into the summary.
  const newTailFrom = Math.max(tailFrom, messages.length - KEEP_TAIL);
  if (newTailFrom <= tailFrom) return { summary, tailFrom }; // nothing more to fold (tail itself is huge)

  const toFold = messages
    .slice(tailFrom, newTailFrom)
    .map((m) => `${m.role}: ${messageText(m)}`)
    .filter((l) => l.length > l.indexOf(":") + 2)
    .join("\n");
  if (!toFold.trim()) {
    tailFrom = newTailFrom;
    await saveSummary(chatId, summary ?? "", tailFrom);
    return { summary, tailFrom };
  }

  try {
    const prompt =
      "/no_think\nYou maintain a running summary of a conversation so it fits a small context window.\n" +
      (summary ? `Existing summary:\n${summary}\n\n` : "") +
      `New earlier messages to fold in:\n${toFold}\n\n` +
      "Write an updated, compact summary (max ~200 words) preserving names, decisions, facts, preferences, and open threads. Output only the summary.";
    const result = streamText({ model: chatModelBackground(), prompt, maxOutputTokens: 400, tools: inertTools, stopWhen: stepCountIs(2) });
    let text = "";
    for await (const d of result.textStream) text += d;
    const next = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (next) {
      summary = next;
      tailFrom = newTailFrom;
      await saveSummary(chatId, summary, tailFrom);
    }
  } catch (err) {
    // Compaction is best-effort: on failure keep the prior summary + tail (the turn
    // still runs, just with more context — never block a chat on summarization).
    console.error("leash: compaction failed, using prior summary:", err);
  }
  return { summary, tailFrom };
}
