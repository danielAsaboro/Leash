/**
 * The nightly LoRA loop: curate → finetune (QVAC Fabric) → version + checksum →
 * score base AND adapter on the frozen eval → write a manifest with the real
 * evalDelta. Only `evalDelta >= 0` manifests are promotable by apply.ts.
 *
 * Same finetune call path proven in spike/04-lora.ts, base swapped to the model the
 * web chat uses (QWEN3_4B_INST_Q4_K_M, or QWEN3_600M_INST_Q4 per the Phase-0 gate).
 * If curation is below the min-viable gate, training is SKIPPED honestly (an audit
 * note) — never a junk adapter.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { finetune, loadModel, unloadModel } from "@qvac/sdk";
import { AuditLog, now } from "@mycelium/shared";
import { QWEN3_4B_INST_Q4_K_M, type ModelSrc } from "@mycelium/senses";
import type { AdapterManifest } from "./types.ts";
import { adapterDir, adapterGguf, adapterManifest, CHECKPOINT_DIR, LOG_DIR, TRAIN_FILE } from "./paths.ts";
import { curateTrainingSet, type CurateResult } from "./curate.ts";
import { runEval } from "./eval.ts";
import { promoteAdapterToServe, type PromoteResult } from "./serve-alias.ts";

export interface TrainBase {
  src: ModelSrc;
  name: string;
}
export const DEFAULT_BASE: TrainBase = { src: QWEN3_4B_INST_Q4_K_M, name: "QWEN3_4B_INST_Q4_K_M" };

export interface RunNightlyLoraParams {
  base?: TrainBase;
  epochs?: number;
  minPairs?: number;
  /** Write the `qwen3-4b-me` serve alias when the adapter is promotable (default true). */
  promote?: boolean;
  audit?: AuditLog;
}

export interface TrainOutcome {
  skipped: boolean;
  reason?: string;
  version?: string;
  manifest?: AdapterManifest;
  /** Set when a promotable 4B adapter was wired into the serve config. */
  served?: PromoteResult;
  curate: CurateResult;
}

/** Compact, sortable version stamp (YYYYMMDD-HHmmss) — lexicographic = chronological. */
function versionStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Newest *.gguf under `dir` (recursive). */
function newestGguf(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const found: { path: string; m: number }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name.endsWith(".gguf")) found.push({ path: p, m: s.mtimeMs });
    }
  };
  walk(dir);
  return found.sort((a, b) => b.m - a.m)[0]?.path;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export async function runNightlyLora(params: RunNightlyLoraParams = {}): Promise<TrainOutcome> {
  const base = params.base ?? DEFAULT_BASE;
  const epochs = params.epochs ?? 2;
  const audit = params.audit ?? new AuditLog("memory-evolve", LOG_DIR);

  // 1. curate (writes train.jsonl when the gate passes)
  const curate = curateTrainingSet({ minPairs: params.minPairs, write: true, audit });
  if (!curate.ok) {
    const reason = `below min-viable gate (${curate.counts.final} < ${curate.minPairs}) — skipped training`;
    audit.record({ event: "note", extra: { role: "evolve", skipped: true, reason } });
    return { skipped: true, reason, curate };
  }

  // 2. finetune the adapter into a fresh versioned dir
  const version = versionStamp();
  const outDir = adapterDir(version);
  mkdirSync(outDir, { recursive: true });
  const ckptDir = join(CHECKPOINT_DIR, version);
  mkdirSync(ckptDir, { recursive: true });

  const baseId = await loadModel({ modelSrc: base.src, modelType: "llm", modelConfig: { device: "gpu", ctx_size: 2048 }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: base.src, modelId: baseId, extra: { role: "train", base: base.name } });

  const tTrain = now();
  const handle = finetune({
    modelId: baseId,
    options: {
      trainDatasetDir: TRAIN_FILE,
      validation: { type: "split", fraction: 0.1 }, // keeps the FROZEN eval fixtures fully untouched
      numberOfEpochs: epochs,
      learningRate: 1e-4,
      lrMin: 1e-8,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
      assistantLossOnly: true,
      checkpointSaveSteps: 8,
      checkpointSaveDir: ckptDir,
      outputParametersDir: outDir,
    },
  });
  for await (const tick of handle.progressStream) {
    audit.record({ event: "finetune_progress", modelSrc: base.src, modelId: baseId, extra: { phase: tick.is_train ? "train" : "val", epoch: tick.current_epoch + 1, step: tick.global_steps, loss: tick.loss, accuracy: tick.accuracy } });
  }
  const result = await handle.result;
  const trainMs = now() - tTrain;
  audit.record({ event: "finetune_result", modelSrc: base.src, modelId: baseId, durationMs: trainMs, extra: { status: result.status, stats: result.stats, version, trainPairs: curate.counts.final } });
  await unloadModel({ modelId: baseId });
  audit.record({ event: "model_unload", modelSrc: base.src, modelId: baseId, extra: { role: "train" } });

  // 3. canonicalize the produced adapter → adapter.gguf
  const produced = newestGguf(outDir);
  if (!produced) throw new Error(`finetune produced no .gguf under ${outDir} (status=${result.status})`);
  const ggufPath = adapterGguf(version);
  if (basename(produced) !== "adapter.gguf") renameSync(produced, ggufPath);
  const sizeBytes = statSync(ggufPath).size;
  const sha256 = sha256File(ggufPath);

  // 4. score base AND adapter on the frozen eval → evalDelta
  const baseRun = await runEval({ label: "base", modelSrc: base.src, modelName: base.name, audit });
  const adapterRun = await runEval({ label: version, modelSrc: base.src, modelName: base.name, adapterPath: ggufPath, audit });
  const evalDelta = adapterRun.overall - baseRun.overall;

  // 5. write the manifest (plain JSON the web/mesh read — never a corestore)
  const manifest: AdapterManifest = {
    version,
    baseModel: base.name,
    adapterFile: "adapter.gguf",
    sha256,
    sizeBytes,
    trainPairs: curate.counts.final,
    createdAt: new Date().toISOString(),
    base: baseRun,
    adapter: adapterRun,
    evalDelta,
  };
  writeFileSync(adapterManifest(version), JSON.stringify(manifest, null, 2));
  audit.record({ event: "note", extra: { role: "evolve", version, evalDelta, sizeBytes, sha256, promotable: evalDelta >= 0 } });

  // 6. promote: only an adapter that did NOT regress reaches the live chat. Writes the
  // qwen3-4b-me serve alias (a serve reload activates it; never kill a live worker).
  let served: PromoteResult | undefined;
  if (evalDelta >= 0 && params.promote !== false) {
    served = promoteAdapterToServe({ ggufPath, baseModelName: base.name, audit });
  }

  return { skipped: false, version, manifest, ...(served ? { served } : {}), curate };
}
