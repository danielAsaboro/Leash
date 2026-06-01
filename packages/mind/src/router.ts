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

/**
 * Classify a query. An exocortex should *default to consulting the private context
 * graph* — a keyword list can never know in advance which question is answered by a
 * personal note or voice memo (e.g. "how long does the Pi battery last?" looks
 * generic but is answered by a voice memo). So we route to the council by default
 * and only shortcut to the small local model for obviously-generic queries
 * (arithmetic, greetings) that no private context could improve.
 */
const ARITHMETIC = /^[\s\d+\-*/×÷=().^%]+\??$/;
const SIMPLE_MATH = /^(what(?:'s| is)|calculate|compute)\s+[-\d(][\s\d+\-*/×÷=().^%]*\??$/;
const GREETING = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|thanks|thank you)\b/;

export function classify(question: string): Classification {
  const q = question.toLowerCase().trim();
  if (ARITHMETIC.test(q) || SIMPLE_MATH.test(q)) return { kind: "trivial", reason: "arithmetic — no personal context can help" };
  if (GREETING.test(q)) return { kind: "trivial", reason: "greeting/social — no personal context needed" };
  // Default: consult the private context graph via the council.
  return { kind: "hard", reason: "may need personal context — consult the graph" };
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
