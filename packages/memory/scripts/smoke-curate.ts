/**
 * `npm run memory:smoke` — NO GPU. Validates the curation pipeline end-to-end on the
 * real on-disk signals, asserting the invariants that keep the loop honest:
 *   1. every produced row is a valid HF-chat pair (user → assistant, non-empty)
 *   2. ZERO overlap between training prompts and the frozen eval fixtures
 *   3. no duplicate normalized prompts survive (dedupe works)
 *   4. the min-viable gate skips honestly when there isn't enough signal
 *
 * Exits non-zero on any failed assertion (CI-friendly).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@mycelium/shared";
import { curateTrainingSet, evalPromptSet, normalizePrompt } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const audit = new AuditLog("memory-smoke", join(here, "..", "logs"));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("=== 🧪 memory:smoke — curation (no GPU) ===\n");

// Dry-run curation (no train.jsonl write) on the real signals.
const res = curateTrainingSet({ write: false, audit });
console.log(`gathered ${res.counts.gathered} → final ${res.counts.final}`);
console.log(`  by source: ${JSON.stringify(res.counts.bySource)}`);
console.log(`  excluded: holdout=${res.counts.excludedHoldout} feedback=${res.counts.excludedFeedback} deduped=${res.counts.deduped}\n`);

// 1. valid HF-chat pairs
const badRows = res.pairs.filter(
  (p) => typeof p.prompt !== "string" || typeof p.answer !== "string" || p.prompt.trim().length < 5 || p.answer.trim().length < 1,
);
check("every pair is a valid user→assistant HF-chat row", badRows.length === 0, `${badRows.length} bad`);

// 2. ZERO eval/train overlap (the honesty guarantee)
const holdout = evalPromptSet();
const leaks = res.pairs.filter((p) => holdout.has(normalizePrompt(p.prompt)));
check("zero training prompts collide with frozen eval fixtures", leaks.length === 0, `${leaks.length} leaks`);
check("eval fixtures are present (holdout non-empty)", holdout.size > 0, `${holdout.size} eval prompts`);

// 3. dedupe — no duplicate normalized prompts survive
const seen = new Set<string>();
let dupes = 0;
for (const p of res.pairs) {
  const k = normalizePrompt(p.prompt);
  if (seen.has(k)) dupes++;
  seen.add(k);
}
check("no duplicate normalized prompts after dedupe", dupes === 0, `${dupes} dupes`);

// 4. min-viable gate skips honestly when signal is thin
const gated = curateTrainingSet({ write: false, minPairs: res.counts.final + 1 });
check("min-viable gate skips (ok=false) below threshold", gated.ok === false, `final=${gated.counts.final} < min=${gated.minPairs}`);
check("curation passes the default gate on real data", res.ok === true, `final=${res.counts.final} >= ${res.minPairs}`);

console.log(`\n${failures === 0 ? "🟢 PASS" : `🔴 FAIL (${failures})`} · Log: ${audit.path}`);
process.exitCode = failures === 0 ? 0 : 1;
