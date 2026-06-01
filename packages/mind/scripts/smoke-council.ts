/**
 * Verification (build sequence step 4): the 2-model council + router, in a single
 * local process.
 *
 *   npm run mind:council
 *
 * GO:
 *   - HARD query routes to the council → cited answer naming the correct model,
 *     verifier verdict "pass", and it BEATS the single-model (no-RAG) baseline.
 *   - TRIVIAL query routes to the local QWEN3_600M_INST_Q4.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, unloadModel, completion, ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import {
  GraphStore,
  loadEmbeddings,
  unloadEmbeddings,
  ingestNodes,
  searchGraph,
  QWEN3_4B_INST_Q4_K_M,
  type Hit,
} from "@mycelium/senses";
import { classify, runCouncil, answerTrivial } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "..", "..", "..", "spike", "fixtures", "notes");
const STORE_FILE = join(here, "..", "logs", "council-graph.jsonl");
const WORKSPACE = "mycelium-council-smoke";
const HARD_Q = "Which model does Dani run on the Raspberry Pi node, and why?";
const TRIVIAL_Q = "What is 2 + 2?";
const audit = new AuditLog("mind-council", join(here, "..", "logs"));
const namesModel = (s: string) => /qwen3?[\s_-]*600m/i.test(s.replace(/\s+/g, ""));

let embId: string | undefined;
let councilId: string | undefined;
try {
  console.log("=== Step 4 — 2-model council + router (single local process) ===\n");

  // Build the context graph from the fixtures.
  rmSync(STORE_FILE, { force: true });
  const store = new GraphStore(STORE_FILE);
  for (const f of readdirSync(NOTES_DIR).filter((n) => n.endsWith(".md"))) {
    store.append({ kind: "file", source: join("spike/fixtures/notes", f), text: readFileSync(join(NOTES_DIR, f), "utf-8").trim() });
  }
  embId = await loadEmbeddings(audit);
  await ingestNodes({ embModelId: embId, workspace: WORKSPACE, nodes: store.all(), audit });

  // The council brain (Mac-class), loaded once with native tools enabled.
  councilId = await loadModel({ modelSrc: QWEN3_4B_INST_Q4_K_M, modelType: "llm", modelConfig: { ctx_size: 4096, tools: true }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: councilId });

  // ---- HARD query ----
  const hardClass = classify(HARD_Q);
  console.log(`🔎 HARD: "${HARD_Q}"\n   classify → ${hardClass.kind} (${hardClass.reason})`);
  if (hardClass.kind !== "hard") throw new Error(`router misrouted the hard query as ${hardClass.kind}`);

  // Baseline: the SAME model, no RAG, no tools — should fumble on the private fact.
  const baseRun = completion({ modelId: councilId, history: [{ role: "user", content: HARD_Q }], stream: true, generationParams: { predict: 256, reasoning_budget: 0 } });
  let baseline = "";
  for await (const t of baseRun.tokenStream) baseline += t;
  baseline = baseline.trim();
  console.log(`\n   single-model baseline (no RAG): names QWEN3_600M = ${namesModel(baseline) ? "yes" : "no"}`);

  // Council: RAG-grounded, tool-calling, verified.
  const runSearch = (query: string, topK: number): Promise<Hit[]> => searchGraph({ embModelId: embId!, workspace: WORKSPACE, query, topK, audit });
  console.log("\n   --- council ---");
  const result = await runCouncil({ deps: { llmModelId: councilId, runSearch, audit, onToken: (t) => process.stdout.write(t) }, question: HARD_Q });
  console.log(`\n   sources=${result.sources.length} · cited=${result.cited} · verdict=${result.verifierVerdict.verdict} · names QWEN3_600M=${namesModel(result.answer)}`);
  console.log(`   trace: ${result.trace.map((s) => (s.step === "search" ? `search(${s.hits}@${s.topScore.toFixed(3)})` : s.step === "verify" ? `verify:${s.verdict}` : `propose#${s.iter}[${s.toolCalls.join(",") || "answer"}]`)).join(" → ")}`);
  audit.record({ event: "note", extra: { phase: "council", cited: result.cited, verdict: result.verifierVerdict.verdict, baselineCorrect: namesModel(baseline), councilCorrect: namesModel(result.answer) } });

  const councilWins = result.cited && namesModel(result.answer) && result.verifierVerdict.verdict === "pass" && !namesModel(baseline);
  if (!councilWins) {
    throw new Error(
      `council did not clearly beat baseline (cited=${result.cited}, councilCorrect=${namesModel(result.answer)}, verdict=${result.verifierVerdict.verdict}, baselineCorrect=${namesModel(baseline)})`,
    );
  }
  console.log("\n   ✅ council cited + correct + verified, and beat the single-model baseline.\n");

  await unloadModel({ modelId: councilId });
  audit.record({ event: "model_unload", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: councilId });
  councilId = undefined;

  // ---- TRIVIAL query ----
  const trivialClass = classify(TRIVIAL_Q);
  console.log(`🔎 TRIVIAL: "${TRIVIAL_Q}"\n   classify → ${trivialClass.kind} (${trivialClass.reason})`);
  if (trivialClass.kind !== "trivial") throw new Error(`router misrouted the trivial query as ${trivialClass.kind}`);
  process.stdout.write("   answer: ");
  const trivialAnswer = await answerTrivial({ question: TRIVIAL_Q, audit, onToken: (t) => process.stdout.write(t) });
  console.log(`\n   (local QWEN3_600M answered ${trivialAnswer.length} chars)`);

  console.log(`\n✅ GO — hard→council (cited, verified, beats baseline); trivial→local 600M. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ council smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (councilId) await unloadModel({ modelId: councilId });
  if (embId) await unloadEmbeddings(embId, audit);
}
