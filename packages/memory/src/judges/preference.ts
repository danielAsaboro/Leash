/**
 * Judge: preference adherence — a HEADLINE axis, scored DETERMINISTICALLY against
 * `mustContain` / `mustNotContain` anchors. An optional LOCAL LLM-judge (via
 * @qvac/sdk — never cloud) can add a softer opinion, but it lands only in `detail`,
 * never in the headline `score` (so the number can't drift on model mood).
 */
import type { AxisScore, PreferenceEvalItem } from "../types.ts";
import type { Complete } from "./recall.ts";

export interface JudgeNote {
  prompt: string;
  adheres: boolean;
  note: string;
}
/** Optional second opinion from a local model. Recorded in detail only. */
export type LocalJudge = (prompt: string, answer: string) => Promise<JudgeNote>;

export async function scorePreference(
  items: PreferenceEvalItem[],
  complete: Complete,
  judge?: LocalJudge,
): Promise<AxisScore> {
  let passed = 0;
  const detail: { prompt: string; pass: boolean; answer: string }[] = [];
  const localJudge: JudgeNote[] = [];
  for (const item of items) {
    const answer = await complete(item.prompt);
    const lc = answer.toLowerCase();
    const mustOk = (item.mustContain ?? []).every((m) => lc.includes(m.toLowerCase()));
    const mustNotOk = (item.mustNotContain ?? []).every((m) => !lc.includes(m.toLowerCase()));
    const pass = mustOk && mustNotOk;
    if (pass) passed++;
    detail.push({ prompt: item.prompt, pass, answer: answer.slice(0, 200) });
    if (judge) localJudge.push(await judge(item.prompt, answer));
  }
  const total = items.length;
  return {
    axis: "preference",
    score: total ? passed / total : 0,
    total,
    passed,
    detail: judge ? { items: detail, localJudge } : detail,
  };
}
