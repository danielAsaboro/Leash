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
import { QWEN3_600M_INST_Q4, type ModelSrc } from "@mycelium/senses";
import type { AdapterManifest } from "./types.ts";
import { ADAPTERS_DIR, adapterDir, adapterGguf, adapterManifest, CHECKPOINT_DIR, LOG_DIR, TRAIN_FILE } from "./paths.ts";
import { curateTrainingSet, type CurateResult } from "./curate.ts";
import { runEval } from "./eval.ts";
import { promoteAdapterToServe, type PromoteResult } from "./serve-alias.ts";

export interface TrainBase {
  src: ModelSrc;
  name: string;
}
/**
 * LoRA base model. QVAC Fabric finetunes only F32/F16/Q4_0/Q8_0/TQ — NOT Q4_K_M, the
 * quant the 4B ships as (file_type=15: "Finetuning is not supported for this quantization
 * type"). QWEN3_600M_INST_Q4 is Q4_0 → trainable (proven by spike 04-lora). The web chat's
 * 4B (qwen3-4b) can only get a personal adapter from a TRAINABLE-quant 4B gguf (Q8_0/Q4_0/
 * F16) supplied as a custom src — not in the QVAC catalog today. So the loop trains the
 * 600M and its "better at you" surface is the edge/council path (router.answerTrivial({lora}));
 * pass a custom `base` to runNightlyLora once you have a trainable 4B gguf.
 */
export const DEFAULT_BASE: TrainBase = { src: QWEN3_600M_INST_Q4, name: "QWEN3_600M_INST_Q4" };

export interface RunNightlyLoraParams {
  base?: TrainBase;
  epochs?: number;
  minPairs?: number;
  /** Write the `qwen3-4b-me` serve alias when the adapter is promotable (default true). */
  promote?: boolean;
  /** Ignore a crashed-but-trained adapter on disk and train fresh (default false → resume it). */
  forceRetrain?: boolean;
  /** Max training sequence length. The finetuner drops examples longer than this; default 512
   *  (the spike's 128 default silently skipped our longest fact pairs). */
  contextLength?: number;
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

/** Newest version dir with an adapter.gguf but NO manifest.json — a run that trained but
 *  crashed before eval/manifest. It can be finalized without paying for another train. */
function newestOrphanAdapter(): { version: string; ggufPath: string } | null {
  if (!existsSync(ADAPTERS_DIR)) return null;
  for (const version of readdirSync(ADAPTERS_DIR).sort().reverse()) {
    const gguf = adapterGguf(version);
    if (existsSync(gguf) && !existsSync(adapterManifest(version))) return { version, ggufPath: gguf };
  }
  return null;
}

/** Score base + adapter on the frozen eval, write the manifest, promote if it didn't regress.
 *  Shared by the fresh-train path and the resume path. */
async function finalizeAdapter(opts: { version: string; ggufPath: string; base: TrainBase; trainPairs: number; promote: boolean; audit: AuditLog }): Promise<{ manifest: AdapterManifest; served?: PromoteResult }> {
  const { version, ggufPath, base, trainPairs, promote, audit } = opts;
  const sizeBytes = statSync(ggufPath).size;
  const sha256 = sha256File(ggufPath);

  const baseRun = await runEval({ label: "base", modelSrc: base.src, modelName: base.name, audit });
  const adapterRun = await runEval({ label: version, modelSrc: base.src, modelName: base.name, adapterPath: ggufPath, audit });
  const evalDelta = adapterRun.overall - baseRun.overall;

  const manifest: AdapterManifest = {
    version,
    baseModel: base.name,
    adapterFile: "adapter.gguf",
    sha256,
    sizeBytes,
    trainPairs,
    createdAt: new Date().toISOString(),
    base: baseRun,
    adapter: adapterRun,
    evalDelta,
  };
  writeFileSync(adapterManifest(version), JSON.stringify(manifest, null, 2));
  audit.record({ event: "note", extra: { role: "evolve", version, evalDelta, sizeBytes, sha256, promotable: evalDelta >= 0 } });

  let served: PromoteResult | undefined;
  if (evalDelta >= 0 && promote) served = promoteAdapterToServe({ ggufPath, baseModelName: base.name, audit });
  return { manifest, ...(served ? { served } : {}) };
}

export async function runNightlyLora(params: RunNightlyLoraParams = {}): Promise<TrainOutcome> {
  const base = params.base ?? DEFAULT_BASE;
  const epochs = params.epochs ?? 2;
  const audit = params.audit ?? new AuditLog("memory-evolve", LOG_DIR);
  const promote = params.promote !== false;

  // Resume: a prior run trained an adapter but crashed before its manifest (e.g. an eval
  // failure). Finalize THAT adapter (eval + manifest) instead of paying for another train.
  if (!params.forceRetrain) {
    const orphan = newestOrphanAdapter();
    if (orphan) {
      audit.record({ event: "note", extra: { role: "evolve", resumed: orphan.version, reason: "trained adapter on disk has no manifest — finalizing without retraining" } });
      const curate = curateTrainingSet({ minPairs: params.minPairs, write: false, audit });
      const { manifest, served } = await finalizeAdapter({ version: orphan.version, ggufPath: orphan.ggufPath, base, trainPairs: curate.counts.final, promote, audit });
      return { skipped: false, version: orphan.version, manifest, ...(served ? { served } : {}), curate };
    }
  }

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
      contextLength: params.contextLength ?? 512, // train on long fact pairs too (default 128 dropped them)
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

  // 4-6. score base + adapter on the frozen eval, write the manifest, promote if it didn't regress.
  const { manifest, served } = await finalizeAdapter({ version, ggufPath, base, trainPairs: curate.counts.final, promote, audit });
  return { skipped: false, version, manifest, ...(served ? { served } : {}), curate };
}
