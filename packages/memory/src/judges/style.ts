/**
 * Judge: style match — embedding cosine (GTE_LARGE_FP16, 1024-dim) between the
 * model's answer and a reference written in the user's voice. Deterministic given
 * the embedding model. The axis score is the mean cosine, clamped to [0,1].
 */
import type { AxisScore, StyleEvalItem } from "../types.ts";
import type { Complete } from "./recall.ts";

export type EmbedText = (text: string) => Promise<number[]>;

/** Cosine similarity of two equal-length vectors (0 if either is degenerate). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Answers within this cosine of the reference count as a style "pass". */
const STYLE_PASS_THRESHOLD = 0.6;

export async function scoreStyle(items: StyleEvalItem[], complete: Complete, embedText: EmbedText): Promise<AxisScore> {
  let sum = 0;
  let passed = 0;
  const detail: { prompt: string; cosine: number; answer: string }[] = [];
  for (const item of items) {
    const answer = await complete(item.prompt);
    const [va, vb] = await Promise.all([embedText(answer), embedText(item.styleRef)]);
    const cos = cosine(va, vb);
    sum += Math.max(0, Math.min(1, cos));
    if (cos >= STYLE_PASS_THRESHOLD) passed++;
    detail.push({ prompt: item.prompt, cosine: Number(cos.toFixed(4)), answer: answer.slice(0, 200) });
  }
  const total = items.length;
  return { axis: "style", score: total ? sum / total : 0, total, passed, detail };
}
