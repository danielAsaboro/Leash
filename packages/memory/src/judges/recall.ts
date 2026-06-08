/**
 * Judge: personal-fact recall — the HEADLINE axis. Deterministic substring match
 * (the spike's `/hollowood/i` discipline): the answer passes iff it contains ANY of
 * the item's `mustMatch` keywords (case-insensitive). No LLM judging, no ambiguity.
 */
import type { AxisScore, RecallEvalItem } from "../types.ts";

export type Complete = (prompt: string) => Promise<string>;

export async function scoreRecall(items: RecallEvalItem[], complete: Complete): Promise<AxisScore> {
  let passed = 0;
  const detail: { prompt: string; hit: boolean; answer: string }[] = [];
  for (const item of items) {
    const answer = await complete(item.prompt);
    const lc = answer.toLowerCase();
    const hit = item.mustMatch.some((m) => lc.includes(m.toLowerCase()));
    if (hit) passed++;
    detail.push({ prompt: item.prompt, hit, answer: answer.slice(0, 200) });
  }
  const total = items.length;
  return { axis: "recall", score: total ? passed / total : 0, total, passed, detail };
}
