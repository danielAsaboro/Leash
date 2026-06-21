import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  curateTrainingSet,
  evalPromptSet,
  evaluateAdapterQuality,
  latestManifest,
  loadEvalSet,
  normalizePrompt,
  type AdapterManifest,
  type AxisScore,
  type EvalRun,
} from "../packages/memory/src/index.ts";
import { adapterGguf, EVAL_PREFERENCE_FILE, EVAL_RECALL_FILE, EVAL_RUNS_FILE, EVAL_STYLE_FILE, REPO_ROOT } from "../packages/memory/src/paths.ts";

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Files(files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex");
}

function mean(axes: AxisScore[]): number {
  return axes.reduce((sum, axis) => sum + axis.score, 0) / axes.length;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12;
}

function readEvalRuns(): EvalRun[] {
  try {
    return readFileSync(EVAL_RUNS_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EvalRun);
  } catch {
    return [];
  }
}

const manifest = latestManifest();
if (manifest === undefined) throw new Error("No adapter manifest and artifact are available");
const adapterPath = adapterGguf(manifest.version);
const evalFiles = [EVAL_RECALL_FILE, EVAL_PREFERENCE_FILE, EVAL_STYLE_FILE];
const evalSet = loadEvalSet();
const expectedTotals = new Map<string, number>([
  ["recall", evalSet.recall.length],
  ["preference", evalSet.preference.length],
  ["style", evalSet.style.length],
]);
const holdout = evalPromptSet(evalSet);
const curated = curateTrainingSet({ write: false });
const leaks = curated.pairs.filter((pair) => holdout.has(normalizePrompt(pair.prompt)));
const quality = evaluateAdapterQuality(manifest);
const artifact = statSync(adapterPath);
const resolvedBaseSource = manifest.baseModelSource.startsWith("~/")
  ? join(homedir(), manifest.baseModelSource.slice(2))
  : manifest.baseModelSource;
const evalRuns = readEvalRuns();
const latestAdapterRunIndex = evalRuns.findLastIndex(
  (run) => run.label === manifest.version && run.model === manifest.baseModel && run.adapterPath === adapterPath,
);
const freshAdapterRun = latestAdapterRunIndex >= 0 ? evalRuns[latestAdapterRunIndex] : undefined;
const freshBaseRun = latestAdapterRunIndex >= 0
  ? evalRuns.slice(0, latestAdapterRunIndex).findLast((run) => run.label === "base" && run.model === manifest.baseModel && run.adapterPath === undefined)
  : undefined;
const freshManifest: AdapterManifest | undefined = freshBaseRun !== undefined && freshAdapterRun !== undefined
  ? {
      ...manifest,
      base: freshBaseRun,
      adapter: freshAdapterRun,
      evalDelta: freshAdapterRun.overall - freshBaseRun.overall,
    }
  : undefined;
const freshQuality = freshManifest === undefined ? undefined : evaluateAdapterQuality(freshManifest);

const checks: Record<string, boolean> = {
  artifactHashMatches: sha256File(adapterPath) === manifest.sha256,
  artifactSizeMatches: artifact.size === manifest.sizeBytes,
  baseModelSourceIsMachineNeutral:
    manifest.baseModelSource === "QWEN3_600M_INST_Q4" || manifest.baseModelSource.startsWith("~/"),
  baseModelSourceResolves:
    manifest.baseModelSource === "QWEN3_600M_INST_Q4" || existsSync(resolvedBaseSource),
  manifestModelMatches: manifest.base.model === manifest.baseModel && manifest.adapter.model === manifest.baseModel,
  manifestLabelsMatch: manifest.base.label === "base" && manifest.adapter.label === manifest.version,
  frozenFixtureCountMatches: holdout.size === 18,
  baseAxisTotalsMatch: manifest.base.axes.every((axis) => axis.total === expectedTotals.get(axis.axis)),
  adapterAxisTotalsMatch: manifest.adapter.axes.every((axis) => axis.total === expectedTotals.get(axis.axis)),
  baseOverallRecomputes: close(mean(manifest.base.axes), manifest.base.overall),
  adapterOverallRecomputes: close(mean(manifest.adapter.axes), manifest.adapter.overall),
  deltaRecomputes: close(manifest.adapter.overall - manifest.base.overall, manifest.evalDelta),
  noCurrentTrainingHoldoutLeak: leaks.length === 0,
  promotionGatePassed: quality.passed,
  freshRescorePairPresent: freshManifest !== undefined,
  freshRescorePromotionGatePassed: freshQuality?.passed === true,
};
const artifactEvidenceValid = Object.values(checks).every(Boolean);
const generatedAt = new Date().toISOString();
const suffix = Date.now().toString(36);
const report = {
  schemaVersion: 1,
  generatedAt,
  qvacOnly: true,
  adapter: {
    version: manifest.version,
    baseModel: manifest.baseModel,
    baseModelSource: manifest.baseModelSource,
    path: adapterPath,
    bytes: artifact.size,
    sha256: manifest.sha256,
    trainPairs: manifest.trainPairs,
  },
  frozenEvaluation: {
    fixtureVersion: "eval-v1",
    fixtureHash: sha256Files(evalFiles),
    counts: Object.fromEntries(expectedTotals),
    prompts: holdout.size,
    baseOverall: manifest.base.overall,
    adapterOverall: manifest.adapter.overall,
    evalDelta: manifest.evalDelta,
    axes: quality.axes,
  },
  qualityGate: quality,
  latestQvacRescore: freshManifest === undefined ? null : {
    baseTimestamp: freshManifest.base.ts,
    adapterTimestamp: freshManifest.adapter.ts,
    baseOverall: freshManifest.base.overall,
    adapterOverall: freshManifest.adapter.overall,
    evalDelta: freshManifest.evalDelta,
    axes: freshQuality?.axes ?? [],
    qualityGate: freshQuality,
  },
  currentRetrainingReadiness: {
    ready: curated.ok,
    finalPairs: curated.counts.final,
    minimumPairs: curated.minPairs,
    gatheredBySource: curated.counts.bySource,
    holdoutLeaks: leaks.length,
  },
  checks,
  artifactEvidenceValid,
};

const logDir = join(REPO_ROOT, "logs");
mkdirSync(logDir, { recursive: true });
const reportPath = join(logDir, `lora-heldout-verification-${suffix}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log("=== LoRA held-out verification ===\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
console.log(`\nbase=${manifest.base.overall.toFixed(6)} adapter=${manifest.adapter.overall.toFixed(6)} delta=${manifest.evalDelta >= 0 ? "+" : ""}${manifest.evalDelta.toFixed(6)}`);
for (const axis of quality.axes) console.log(`${axis.axis}: ${axis.base.toFixed(6)} -> ${axis.adapter.toFixed(6)} (${axis.delta >= 0 ? "+" : ""}${axis.delta.toFixed(6)})`);
console.log(`promotion=${quality.passed ? "PASS" : "FAIL"}`);
if (freshManifest !== undefined && freshQuality !== undefined) {
  console.log(`fresh QVAC rescore=${freshManifest.base.overall.toFixed(6)} -> ${freshManifest.adapter.overall.toFixed(6)} (${freshManifest.evalDelta >= 0 ? "+" : ""}${freshManifest.evalDelta.toFixed(6)})`);
  for (const axis of freshQuality.axes) console.log(`fresh ${axis.axis}: ${axis.base.toFixed(6)} -> ${axis.adapter.toFixed(6)} (${axis.delta >= 0 ? "+" : ""}${axis.delta.toFixed(6)})`);
}
console.log(`fresh retraining=${curated.ok ? "READY" : `WAITING (${curated.counts.final}/${curated.minPairs} accepted signals)`}`);
console.log(`report=${reportPath}`);

if (!artifactEvidenceValid) process.exitCode = 1;
