/**
 * The eval harness: score ONE model (base or adapter) on the fixed, frozen eval set
 * across the 3 spec axes, then append the run to `data/evolve/eval-runs.jsonl`.
 *
 * Every run is logged UNCONDITIONALLY — base and adapter, success or regression — so
 * the growth chart is re-derivable from the log and can never be cherry-picked.
 * `overall` (the mean of the deterministic axis scores) is the number `evalDelta`
 * compares.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { completion, embed, loadModel, unloadModel } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, QWEN3_4B_INST_Q4_K_M, type ModelSrc } from "@mycelium/senses";
import type { AxisScore, EvalRun } from "./types.ts";
import { EVAL_RUNS_FILE } from "./paths.ts";
import { loadEvalSet } from "./eval-set.ts";
import { scoreRecall, type Complete } from "./judges/recall.ts";
import { scorePreference, type LocalJudge } from "./judges/preference.ts";
import { scoreStyle, type EmbedText } from "./judges/style.ts";

export interface RunEvalParams {
  /** "base" or the adapter version. */
  label: string;
  /** Base model under test (default QWEN3_4B_INST_Q4_K_M). */
  modelSrc?: ModelSrc;
  /** Constant name recorded in the run (default "QWEN3_4B_INST_Q4_K_M"). */
  modelName?: string;
  /** Apply this LoRA adapter at load (the adapter run). */
  adapterPath?: string;
  /** Optional local LLM-judge for the preference axis (detail only). */
  localJudge?: LocalJudge;
  /** Append to eval-runs.jsonl (default true). */
  append?: boolean;
  audit?: AuditLog;
}

/** Mean of the per-axis scores — the headline `overall` used for evalDelta. */
function overallOf(axes: AxisScore[]): number {
  if (axes.length === 0) return 0;
  return axes.reduce((s, a) => s + a.score, 0) / axes.length;
}

export async function runEval(params: RunEvalParams): Promise<EvalRun> {
  const modelSrc = params.modelSrc ?? QWEN3_4B_INST_Q4_K_M;
  const modelName = params.modelName ?? "QWEN3_4B_INST_Q4_K_M";
  const append = params.append ?? true;
  const audit = params.audit;
  const set = loadEvalSet();

  const modelConfig: Record<string, unknown> = { device: "gpu", ctx_size: 2048 };
  if (params.adapterPath) modelConfig["lora"] = params.adapterPath;
  const llmId = await loadModel({ modelSrc, modelType: "llm", modelConfig, onProgress: () => {} });
  audit?.record({ event: "model_load", modelSrc, modelId: llmId, extra: { role: "eval", label: params.label, lora: params.adapterPath } });
  const embId = await loadEmbeddings(audit);

  const complete: Complete = async (prompt: string) => {
    const run = completion({ modelId: llmId, history: [{ role: "user", content: prompt }], stream: true, generationParams: { predict: 256, reasoning_budget: 0 } });
    let out = "";
    for await (const t of run.tokenStream) out += t;
    return out.trim();
  };
  const embedText: EmbedText = async (text: string) => (await embed({ modelId: embId, text })).embedding;

  try {
    const axes: AxisScore[] = [
      await scoreRecall(set.recall, complete),
      await scorePreference(set.preference, complete, params.localJudge),
      await scoreStyle(set.style, complete, embedText),
    ];
    const run: EvalRun = {
      ts: new Date().toISOString(),
      label: params.label,
      model: modelName,
      ...(params.adapterPath ? { adapterPath: params.adapterPath } : {}),
      axes,
      overall: overallOf(axes),
    };
    if (append) {
      mkdirSync(dirname(EVAL_RUNS_FILE), { recursive: true });
      appendFileSync(EVAL_RUNS_FILE, JSON.stringify(run) + "\n");
    }
    audit?.record({
      event: "eval",
      modelId: llmId,
      extra: { label: params.label, overall: run.overall, axes: axes.map((a) => ({ axis: a.axis, score: a.score, passed: a.passed, total: a.total })) },
    });
    return run;
  } finally {
    await unloadEmbeddings(embId, audit);
    await unloadModel({ modelId: llmId });
    audit?.record({ event: "model_unload", modelSrc, modelId: llmId, extra: { role: "eval", label: params.label } });
  }
}
