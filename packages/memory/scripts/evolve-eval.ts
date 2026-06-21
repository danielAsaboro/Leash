/**
 * `npm run evolve:eval` — re-run the eval ONLY (no training): score the base and the
 * newest adapter on the frozen fixtures, appending both runs to eval-runs.jsonl. Use
 * to refresh the growth chart from current models without spending a training cycle.
 *
 *   npm run evolve:eval
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@mycelium/shared";
import { latestAdapter, runEval, DEFAULT_BASE } from "../src/index.ts";
import type { AdapterManifest, TrainBase } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const audit = new AuditLog("memory-evolve-eval", join(here, "..", "logs"));

function evaluationBase(manifest: AdapterManifest): TrainBase {
  if (manifest.baseModelSource === DEFAULT_BASE.sourceRef) {
    if (manifest.baseModel !== DEFAULT_BASE.name) {
      throw new Error(`Adapter base ${manifest.baseModel} does not match catalog source ${manifest.baseModelSource}`);
    }
    return DEFAULT_BASE;
  }
  const src = manifest.baseModelSource.startsWith("~/")
    ? join(homedir(), manifest.baseModelSource.slice(2))
    : manifest.baseModelSource;
  return { name: manifest.baseModel, src, sourceRef: manifest.baseModelSource };
}

try {
  console.log("=== 📏 evolve:eval — re-score base + latest adapter ===\n");
  const adapter = latestAdapter({ minDelta: -Infinity, maxAxisRegression: Infinity }); // re-score whatever exists, promotable or not
  if (adapter) {
    const base = evaluationBase(adapter.manifest);
    console.log(`base: ${base.name} (${String(base.src)})\n`);
    const baseRun = await runEval({ label: "base", modelSrc: base.src, modelName: base.name, audit });
    console.log(`base    overall: ${baseRun.overall.toFixed(3)}  [${baseRun.axes.map((a) => `${a.axis}=${a.score.toFixed(2)}`).join(" ")}]`);
    const adapterRun = await runEval({ label: adapter.version, modelSrc: base.src, modelName: base.name, adapterPath: adapter.ggufPath, audit });
    console.log(`adapter overall: ${adapterRun.overall.toFixed(3)}  [${adapterRun.axes.map((a) => `${a.axis}=${a.score.toFixed(2)}`).join(" ")}]`);
    console.log(`evalDelta: ${(adapterRun.overall - baseRun.overall >= 0 ? "+" : "")}${(adapterRun.overall - baseRun.overall).toFixed(3)}`);
  } else {
    console.log("(no adapter on disk yet — run `npm run evolve` first)");
  }
  console.log(`\n✅ Log: ${audit.path}`);
} catch (error) {
  console.error("❌ evolve:eval failed:", error);
  audit.record({ event: "note", extra: { role: "evolve-eval", error: String(error) } });
  process.exitCode = 1;
}
