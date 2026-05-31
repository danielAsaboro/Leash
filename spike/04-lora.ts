/**
 * Spike (d) — on-device LoRA via QVAC Fabric.
 *
 * Fine-tunes a tiny adapter on QWEN3_600M_INST_Q4 that teaches one personal fact
 * (Dani's mesh codename is "Hollowood"), then loads the adapter back and shows the
 * answer changes vs the base model.
 *
 * GO criteria: a .gguf adapter is produced AND an observable behavior change is
 * loaded back via modelConfig.lora.
 *
 *   npm run spike:lora
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadModel,
  unloadModel,
  completion,
  finetune,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("04-lora");
const here = dirname(fileURLToPath(import.meta.url));
const TRAIN = join(here, "fixtures", "train.jsonl");
const EVAL = join(here, "fixtures", "eval.jsonl");
const RESULTS_DIR = join(here, "results");
const CKPT_DIR = join(here, "checkpoints");
const PROBE = "What is the codename of Dani's device mesh? Answer in one word.";

async function ask(modelId: string, label: string): Promise<string> {
  const r = completion({ modelId, history: [{ role: "user", content: PROBE }], stream: true });
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
  console.log("=== (d) On-device LoRA (QVAC Fabric) ===\n");

  console.log("BASE model answer (before fine-tune):");
  baseId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4, modelType: "llm", modelConfig: { device: "gpu", ctx_size: 512 }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: QWEN3_600M_INST_Q4, modelId: baseId, extra: { phase: "base" } });
  const baseAnswer = await ask(baseId, "base");
  audit.record({ event: "completion", modelSrc: QWEN3_600M_INST_Q4, modelId: baseId, prompt: PROBE, extra: { phase: "base", mentionsTarget: /hollowood/i.test(baseAnswer) } });

  console.log("\n🔧 Fine-tuning a LoRA adapter (2 epochs)…");
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
    audit.record({ event: "finetune_progress", modelSrc: QWEN3_600M_INST_Q4, modelId: baseId, extra: { phase, epoch: tick.current_epoch + 1, step: tick.global_steps, loss: tick.loss, accuracy: tick.accuracy } });
  }
  const result = await handle.result;
  const trainMs = now() - tTrain;
  audit.record({ event: "finetune_result", modelSrc: QWEN3_600M_INST_Q4, modelId: baseId, durationMs: trainMs, extra: { status: result.status, stats: result.stats } });
  console.log(`✅ Fine-tune ${result.status} in ${(trainMs / 1000).toFixed(1)}s`);

  await unloadModel({ modelId: baseId });
  audit.record({ event: "model_unload", modelSrc: QWEN3_600M_INST_Q4, modelId: baseId });
  baseId = undefined;

  const adapter = findAdapter();
  if (!adapter) throw new Error(`No .gguf adapter found under ${RESULTS_DIR}`);
  console.log(`\n📦 Adapter produced: ${adapter}`);
  audit.record({ event: "note", extra: { adapterPath: adapter } });

  console.log("\nADAPTER model answer (after fine-tune, loaded via modelConfig.lora):");
  const tunedId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4, modelType: "llm", modelConfig: { device: "gpu", ctx_size: 512, lora: adapter }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: QWEN3_600M_INST_Q4, modelId: tunedId, extra: { phase: "adapter", lora: adapter } });
  const tunedAnswer = await ask(tunedId, "adapter");
  const changed = tunedAnswer !== baseAnswer;
  const learned = /hollowood/i.test(tunedAnswer);
  audit.record({ event: "completion", modelSrc: QWEN3_600M_INST_Q4, modelId: tunedId, prompt: PROBE, extra: { phase: "adapter", changed, learnedTarget: learned } });
  await unloadModel({ modelId: tunedId });

  console.log(`\nBehavior changed vs base: ${changed ? "yes" : "no"} · learned target fact ("Hollowood"): ${learned ? "yes" : "no"}`);
  console.log(`✅ GO if an adapter .gguf was produced and the answer changed. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ lora spike failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
  if (baseId) { try { await unloadModel({ modelId: baseId }); } catch {} }
}
