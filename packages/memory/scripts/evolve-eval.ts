/**
 * `npm run evolve:eval` — re-run the eval ONLY (no training): score the base and the
 * newest adapter on the frozen fixtures, appending both runs to eval-runs.jsonl. Use
 * to refresh the growth chart from current models without spending a training cycle.
 *
 *   npm run evolve:eval
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@mycelium/shared";
import { latestAdapter, runEval, DEFAULT_BASE } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const audit = new AuditLog("memory-evolve-eval", join(here, "..", "logs"));

try {
  console.log("=== 📏 evolve:eval — re-score base + latest adapter ===\n");
  const baseRun = await runEval({ label: "base", modelSrc: DEFAULT_BASE.src, modelName: DEFAULT_BASE.name, audit });
  console.log(`base    overall: ${baseRun.overall.toFixed(3)}  [${baseRun.axes.map((a) => `${a.axis}=${a.score.toFixed(2)}`).join(" ")}]`);

  const adapter = latestAdapter({ minDelta: -Infinity }); // re-score whatever exists, promotable or not
  if (adapter) {
    const adapterRun = await runEval({ label: adapter.version, modelSrc: DEFAULT_BASE.src, modelName: DEFAULT_BASE.name, adapterPath: adapter.ggufPath, audit });
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
