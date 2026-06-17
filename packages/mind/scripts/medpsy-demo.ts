/**
 * MedPsy health-record RAG demo (Psy Models track).
 *
 *   npm run medpsy:demo
 *
 * Proves a real specialized-model workflow end-to-end, on-device, via @qvac/sdk:
 *   1. Ingest a folder of PRIVATE health records (synthetic fixtures) into a
 *      dedicated `health-records` RAG workspace (gte-large embeddings).
 *   2. Load the MedPsy model (MedGemma 4B — the `medpsy` alias).
 *   3. Ask a health question → runMedPsyConsult grounds the answer in the records
 *      via search_graph, cites [Source N], verifies the claims, and guarantees a
 *      non-diagnostic disclaimer.
 *   4. Ask a red-flag question → the emergency banner is prepended.
 *
 * GO:
 *   - grounded answer cites at least one source, the verifier verdict is "pass",
 *     the disclaimer is present, and the answer references a value that is actually
 *     in the records (e.g. the cholesterol/LDL numbers);
 *   - the red-flag question trips the emergency escalation.
 *
 * No cloud calls; no mocks. The records are synthetic fixtures; the inference,
 * embeddings, RAG, and verification are all real @qvac/sdk on-device calls.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, unloadModel, ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import {
  GraphStore,
  loadEmbeddings,
  unloadEmbeddings,
  ingestNodes,
  searchGraph,
  MEDGEMMA_4B_IT_Q4_1,
  type Hit,
} from "@mycelium/senses";
import { runMedPsyConsult } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RECORDS_DIR = join(here, "..", "..", "..", "spike", "fixtures", "health-records");
const STORE_FILE = join(here, "..", "logs", "medpsy-graph.jsonl");
const WORKSPACE = "mycelium-health-records";
const GROUNDED_Q = "What were my most recent cholesterol numbers, are they improving, and should I be worried?";
const REDFLAG_Q = "I've had crushing chest pain and shortness of breath for the last 20 minutes — what should I do?";
const audit = new AuditLog("medpsy-demo", join(here, "..", "logs"));
// A record-grounded answer should surface a real value from the fixtures.
const mentionsRecordValue = (s: string) => /\b(214|139|48|156|cholesterol|ldl)\b/i.test(s);

let embId: string | undefined;
let medpsyId: string | undefined;
try {
  console.log("=== MedPsy health-record RAG demo (on-device, @qvac/sdk) ===\n");

  // 1. Build the private health-records context graph from the fixtures.
  rmSync(STORE_FILE, { force: true });
  const store = new GraphStore(STORE_FILE);
  for (const f of readdirSync(RECORDS_DIR).filter((n) => n.endsWith(".md"))) {
    store.append({ kind: "file", source: join("health-records", f), text: readFileSync(join(RECORDS_DIR, f), "utf-8").trim() });
  }
  embId = await loadEmbeddings(audit);
  const chunks = await ingestNodes({ embModelId: embId, workspace: WORKSPACE, nodes: store.all(), audit });
  console.log(`📁 Ingested ${store.all().length} health records → ${chunks} chunks in workspace "${WORKSPACE}".\n`);

  // 2. Load the MedPsy model (MedGemma 4B; the `medpsy` alias), native tools on, 8k ctx (per serve config).
  medpsyId = await loadModel({ modelSrc: MEDGEMMA_4B_IT_Q4_1, modelType: "llm", modelConfig: { ctx_size: 8192, tools: true }, onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: MEDGEMMA_4B_IT_Q4_1, modelId: medpsyId });

  const runSearch = (query: string, topK: number): Promise<Hit[]> => searchGraph({ embModelId: embId!, workspace: WORKSPACE, query, topK, audit });

  // 3. Grounded health question.
  console.log(`🩺 Q: "${GROUNDED_Q}"\n   --- MedPsy ---`);
  const grounded = await runMedPsyConsult({ deps: { llmModelId: medpsyId, runSearch, audit, onToken: (t) => process.stdout.write(t) }, question: GROUNDED_Q });
  console.log(
    `\n\n   sources=${grounded.sources.length} · cited=${grounded.cited} · verdict=${grounded.verifierVerdict.verdict}` +
      ` · disclaimer=${grounded.disclaimerPresent} (appended=${grounded.disclaimerAppended}) · usesRecordValue=${mentionsRecordValue(grounded.answer)}`,
  );

  const groundedOk = grounded.cited && grounded.verifierVerdict.verdict === "pass" && grounded.disclaimerPresent && mentionsRecordValue(grounded.answer);
  if (!groundedOk) {
    throw new Error(
      `grounded consult did not meet the bar (cited=${grounded.cited}, verdict=${grounded.verifierVerdict.verdict}, disclaimer=${grounded.disclaimerPresent}, usesRecordValue=${mentionsRecordValue(grounded.answer)})`,
    );
  }
  console.log("   ✅ grounded in records, cited, verified, disclaimer present.\n");

  // 4. Red-flag / emergency question → escalation banner.
  console.log(`🚨 Q: "${REDFLAG_Q}"\n   --- MedPsy ---`);
  const redflag = await runMedPsyConsult({ deps: { llmModelId: medpsyId, runSearch, audit, onToken: (t) => process.stdout.write(t) }, question: REDFLAG_Q });
  console.log(`\n\n   redFlag=${redflag.redFlag} · escalated=${redflag.answer.startsWith("⚠️")}`);
  if (!redflag.redFlag || !redflag.answer.startsWith("⚠️")) {
    throw new Error(`red-flag question did not escalate (redFlag=${redflag.redFlag})`);
  }
  console.log("   ✅ emergency escalation fired.\n");

  console.log(`✅ GO — MedPsy answered grounded + cited + verified + safety-wrapped, and escalated an emergency. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ medpsy demo failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (medpsyId) await unloadModel({ modelId: medpsyId });
  if (embId) await unloadEmbeddings(embId, audit);
}
