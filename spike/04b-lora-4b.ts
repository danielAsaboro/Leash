/**
 * Spike (d′) — 4B LoRA de-risk for Layer 4 ("The Understory").
 *
 * Mirror of 04-lora.ts but on QWEN3_4B_INST_Q4_K_M — the model the web chat
 * actually uses — to answer ONE gating question before we build packages/memory on
 * it: does a 4B LoRA fine-tune fit and converge on this 24 GB Mac?
 *
 * Teaches one fresh personal fact (Dani's Raspberry Pi edge node is nicknamed
 * "Sporeling") the 4B base does not know, then loads the adapter back via
 * modelConfig.lora and checks the answer changed.
 *
 * Measures (the Phase-0 decision inputs):
 *   - convergence    — first vs last TRAIN loss over 2 epochs (decreasing?)
 *   - peak memory    — process RSS sampled during training (unified-memory proxy;
 *                      cross-check Activity Monitor — Metal allocs aren't all in RSS)
 *   - wall-clock     — fine-tune duration
 *   - behavior change — base answer vs adapter answer, and learned-target hit
 *
 * GO   → build packages/memory on the 4B base (qwen3-4b-me live alias).
 * NO-GO (OOM / too slow / won't converge) → fall back to QWEN3_600M_INST_Q4 per the
 *        spec risk register; the loop is identical, only the base constant changes.
 *
 *   npm run spike:lora4b
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freemem, totalmem } from "node:os";
import {
  loadModel,
  unloadModel,
  completion,
  finetune,
  QWEN3_4B_INST_Q4_K_M,
} from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("04b-lora-4b");
const here = dirname(fileURLToPath(import.meta.url));
const TRAIN = join(here, "fixtures", "lora4b", "train.jsonl");
const EVAL = join(here, "fixtures", "lora4b", "eval.jsonl");
const RESULTS_DIR = join(here, "results", "lora4b");
const CKPT_DIR = join(here, "checkpoints", "lora4b");
const PROBE = "What is the nickname of Dani's Raspberry Pi edge node? Answer in one word.";
const TARGET = /sporeling/i;
const GB = 1024 * 1024 * 1024;

async function ask(modelId: string, label: string): Promise<string> {
  // reasoning_budget:0 disables QWEN3's chain-of-thought; predict caps output — so
  // base-vs-adapter answers are short, comparable, and never overflow the context.
  const r = completion({
    modelId,
    history: [{ role: "user", content: PROBE }],
    stream: true,
    generationParams: { predict: 200, reasoning_budget: 0 },
  });
  let out = "";
  for await (const t of r.tokenStream) out += t;
  out = out.trim();
  console.log(`   ${label}: ${out.replace(/\s+/g, " ").slice(0, 160)}`);
  return out;
}

/** Newest .gguf written under RESULTS_DIR (the produced adapter). */
function findAdapter(): string | undefined {
  if (!existsSync(RESULTS_DIR)) return undefined;
  const ggufs: { path: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name.endsWith(".gguf")) ggufs.push({ path: p, mtime: s.mtimeMs });
    }
  };
  walk(RESULTS_DIR);
  return ggufs.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

mkdirSync(RESULTS_DIR, { recursive: true });
mkdirSync(CKPT_DIR, { recursive: true });

let baseId: string | undefined;
try {
  console.log("=== (d′) 4B LoRA de-risk (QVAC Fabric) ===\n");
  console.log(`host memory: ${(totalmem() / GB).toFixed(1)} GB total · ${(freemem() / GB).toFixed(1)} GB free at start\n`);

  console.log("BASE model answer (before fine-tune):");
  baseId = await loadModel({ modelSrc: QWEN3_4B_INST_Q4_K_M, modelType: "llm", modelConfig: { device: "gpu", ctx_size: 2048 }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: baseId, extra: { phase: "base" } });
  const baseAnswer = await ask(baseId, "base");
  audit.record({ event: "completion", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: baseId, prompt: PROBE, extra: { phase: "base", mentionsTarget: TARGET.test(baseAnswer) } });

  console.log("\n🔧 Fine-tuning a 4B LoRA adapter (2 epochs)…");
  // Peak-RSS sampler: poll process RSS every 500ms during training. On Apple Silicon
  // GPU memory is unified, so RSS captures much (not all) of the Metal allocation —
  // an honest lower-bound proxy. Activity Monitor is the cross-check.
  let peakRssBytes = process.memoryUsage().rss;
  let minFreeBytes = freemem();
  const memTimer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    minFreeBytes = Math.min(minFreeBytes, freemem());
  }, 500);

  let firstTrainLoss: number | undefined;
  let lastTrainLoss: number | undefined;
  const tTrain = now();
  const handle = finetune({
    modelId: baseId,
    options: {
      trainDatasetDir: TRAIN,
      validation: { type: "dataset", path: EVAL },
      numberOfEpochs: 2,
      learningRate: 1e-4,
      lrMin: 1e-8,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
      assistantLossOnly: true,
      checkpointSaveSteps: 4,
      checkpointSaveDir: CKPT_DIR,
      outputParametersDir: RESULTS_DIR,
    },
  });

  for await (const tick of handle.progressStream) {
    const phase = tick.is_train ? "train" : "val";
    const loss = typeof tick.loss === "number" ? tick.loss.toFixed(4) : String(tick.loss);
    console.log(`   epoch=${tick.current_epoch + 1} step=${tick.global_steps} ${phase} loss=${loss}`);
    if (tick.is_train && typeof tick.loss === "number") {
      if (firstTrainLoss === undefined) firstTrainLoss = tick.loss;
      lastTrainLoss = tick.loss;
    }
    audit.record({ event: "finetune_progress", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: baseId, extra: { phase, epoch: tick.current_epoch + 1, step: tick.global_steps, loss: tick.loss, accuracy: tick.accuracy } });
  }
  const result = await handle.result;
  const trainMs = now() - tTrain;
  clearInterval(memTimer);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const peakRssGb = peakRssBytes / GB;
  const minFreeGb = minFreeBytes / GB;
  const lossDropped = firstTrainLoss !== undefined && lastTrainLoss !== undefined && lastTrainLoss < firstTrainLoss;
  audit.record({ event: "finetune_result", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: baseId, durationMs: trainMs, extra: { status: result.status, stats: result.stats, firstTrainLoss, lastTrainLoss, lossDropped, peakRssGb, minFreeGb } });
  console.log(`✅ Fine-tune ${result.status} in ${(trainMs / 1000).toFixed(1)}s`);
  console.log(`   loss: ${firstTrainLoss?.toFixed(4)} → ${lastTrainLoss?.toFixed(4)} (${lossDropped ? "decreasing ✓" : "NOT decreasing ✗"})`);
  console.log(`   peak process RSS: ${peakRssGb.toFixed(2)} GB · min host free: ${minFreeGb.toFixed(2)} GB`);

  await unloadModel({ modelId: baseId });
  audit.record({ event: "model_unload", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: baseId });
  baseId = undefined;

  const adapter = findAdapter();
  if (!adapter) throw new Error(`No .gguf adapter found under ${RESULTS_DIR}`);
  const adapterMb = statSync(adapter).size / (1024 * 1024);
  console.log(`\n📦 Adapter produced: ${adapter} (${adapterMb.toFixed(1)} MB)`);
  audit.record({ event: "note", extra: { adapterPath: adapter, adapterMb } });

  console.log("\nADAPTER model answer (after fine-tune, loaded via modelConfig.lora):");
  const tunedId = await loadModel({ modelSrc: QWEN3_4B_INST_Q4_K_M, modelType: "llm", modelConfig: { device: "gpu", ctx_size: 2048, lora: adapter }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: tunedId, extra: { phase: "adapter", lora: adapter } });
  const tunedAnswer = await ask(tunedId, "adapter");
  const changed = tunedAnswer !== baseAnswer;
  const learned = TARGET.test(tunedAnswer);
  audit.record({ event: "completion", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: tunedId, prompt: PROBE, extra: { phase: "adapter", changed, learnedTarget: learned } });
  await unloadModel({ modelId: tunedId });

  const go = result.status === "COMPLETED" && !!adapter && changed && lossDropped;
  console.log("\n────────── 4B LoRA de-risk verdict ──────────");
  console.log(`  adapter produced : ${adapter ? "yes" : "no"} (${adapterMb.toFixed(1)} MB)`);
  console.log(`  converged (2 ep) : ${lossDropped ? "yes" : "no"} (${firstTrainLoss?.toFixed(4)} → ${lastTrainLoss?.toFixed(4)})`);
  console.log(`  wall-clock       : ${(trainMs / 1000).toFixed(1)}s`);
  console.log(`  peak RSS / free  : ${peakRssGb.toFixed(2)} GB / min ${minFreeGb.toFixed(2)} GB free`);
  console.log(`  behavior changed : ${changed ? "yes" : "no"} · learned "Sporeling": ${learned ? "yes" : "no"}`);
  console.log(`\n  ${go ? "🟢 GO — build packages/memory on QWEN3_4B_INST_Q4_K_M" : "🔴 NO-GO — fall back to QWEN3_600M_INST_Q4 (spec risk register)"}`);
  console.log(`  Record this verdict in the design doc + submission/sawdust.md. Log: ${audit.path}`);
  audit.record({ event: "note", extra: { verdict: go ? "GO" : "NO-GO", changed, learned, lossDropped, trainMs, peakRssGb, minFreeGb, adapterMb } });
} catch (error) {
  console.error("❌ 4B lora spike failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
  if (baseId) { try { await unloadModel({ modelId: baseId }); } catch {} }
}
