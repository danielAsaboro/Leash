/**
 * The router (Layer 3 — Mind).
 *
 * `classify` is a cheap, dependency-free heuristic deciding whether a query is
 * trivial (answerable by a single small model) or hard (needs the RAG-grounded
 * council). `answerTrivial` is the trivial path: one streamed completion from the
 * small local model (`QWEN3_600M_INST_Q4`) on the edge device — no graph, no tools.
 */
import { loadModel, unloadModel, completion } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import { QWEN3_600M_INST_Q4 } from "@mycelium/senses";

export interface Classification {
  kind: "trivial" | "hard";
  reason: string;
}

/** Signals that a query needs the user's private context (→ council). */
const PERSONAL = [
  /\bmy\b/, /\bmine\b/, /\bme\b/, /\bi\b/, /\bour\b/, /\bwe\b/,
  /\bprefer/, /\bremember\b/, /\bnote(s)?\b/,
  /\bdani\b/, /\bmesh\b/, /\brhizo\b/, /\bsporangium\b/, /\bhypha\b/, /\bconidia\b/, /\bhollowood\b/,
  /\bnode\b/, /\bdevice/, /\bvault\b/, /\bproject\b/, /\badapter\b/, /\blora\b/,
];

export function classify(question: string): Classification {
  const q = question.toLowerCase();
  if (PERSONAL.some((re) => re.test(q))) return { kind: "hard", reason: "personal-context keyword" };
  const questionMarks = (question.match(/\?/g) ?? []).length;
  if (questionMarks > 1) return { kind: "hard", reason: "multiple questions" };
  const words = question.trim().split(/\s+/).filter(Boolean).length;
  if (words > 12) return { kind: "hard", reason: "long/complex query" };
  return { kind: "trivial", reason: "short, no personal context" };
}

export interface AnswerTrivialParams {
  question: string;
  audit?: AuditLog;
  onToken?: (token: string) => void;
}

/** Trivial path: load the small local model, stream one answer, unload. Returns the text. */
export async function answerTrivial({ question, audit, onToken }: AnswerTrivialParams): Promise<string> {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelType: "llm",
    modelConfig: { ctx_size: 2048 },
    onProgress: () => {},
  });
  audit?.record({ event: "model_load", modelSrc: QWEN3_600M_INST_Q4, modelId });

  const run = completion({
    modelId,
    history: [{ role: "user", content: question }],
    stream: true,
    generationParams: { predict: 256, reasoning_budget: 0 },
  });
  let out = "";
  for await (const t of run.tokenStream) {
    out += t;
    onToken?.(t);
  }
  const stats = await run.stats;
  audit?.record({
    event: "completion",
    modelSrc: QWEN3_600M_INST_Q4,
    modelId,
    prompt: question,
    tokens: stats?.generatedTokens,
    ttftMs: stats?.timeToFirstToken != null ? Math.round(stats.timeToFirstToken) : undefined,
    tokensPerSecond: stats?.tokensPerSecond,
    extra: { role: "trivial" },
  });

  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelSrc: QWEN3_600M_INST_Q4, modelId });
  return out.trim();
}
