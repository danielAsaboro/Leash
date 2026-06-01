/**
 * Mycelium edge node — the weak consumer (the "phone").
 *
 *   npm run ask -- "<question>" [<hub-public-key>]
 *
 * The router decides:
 *   - TRIVIAL → answered locally by the small QWEN3_600M model. No hub needed.
 *   - HARD    → the edge keeps a LOCAL graph replica (Week-1 stand-in for Week-2
 *               CRDT sync; the SDK can't delegate RAG, so search must be local),
 *               does its own light retrieval, and delegates the heavy council
 *               reasoning (QWEN3_4B proposer + verifier) to the hub over encrypted
 *               P2P. Tokens are generated on the hub's GPU and streamed back.
 *
 * Audit trail for a hard query: delegation → rag_search → completion(proposer) →
 * completion(verifier) → note.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { close, ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, ingestNotesDir, searchGraph, QWEN3_4B_INST_Q4_K_M, type Hit } from "@mycelium/senses";
import { classify, answerTrivial, runCouncil } from "@mycelium/mind";
import { loadDelegated } from "@mycelium/mesh";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "..", "..", "..", "data", "notes");
const GRAPH_FILE = join(here, "..", "data", "graph.jsonl");
const EDGE_WORKSPACE = "mycelium-edge";
const LOG_DIR = join(here, "..", "logs");

const question = process.argv[2];
const hubPublicKey = process.argv[3];
if (!question) {
  console.error('usage: npm run ask -- "<question>" [<hub-public-key>]');
  process.exit(1);
}
const audit = new AuditLog("edge-node", LOG_DIR);
const write = (t: string) => process.stdout.write(t);

async function runTrivial(question: string): Promise<void> {
  console.log("🟢 router → TRIVIAL (local QWEN3_600M)\n");
  process.stdout.write("answer: ");
  await answerTrivial({ question, audit, onToken: write });
  process.stdout.write("\n");
}

async function runHard(question: string): Promise<void> {
  if (!hubPublicKey) {
    console.error("❌ HARD query needs a hub public key: npm run ask -- \"<q>\" <hub-pubkey>");
    process.exit(1);
  }
  console.log(`🔴 router → HARD (delegated council on hub ${hubPublicKey.slice(0, 16)}…)\n`);

  // Local graph replica + light retrieval stay on the edge (RAG can't be delegated).
  const embId = await loadEmbeddings(audit);
  const { nodes, chunks } = await ingestNotesDir({ notesDir: NOTES_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: EDGE_WORKSPACE, audit });
  console.log(`🧩 local graph replica: ${nodes} notes → ${chunks} chunks`);

  // Heavy council reasoning is delegated to the hub.
  const councilId = await loadDelegated({ modelSrc: QWEN3_4B_INST_Q4_K_M, providerPublicKey: hubPublicKey, audit });
  console.log(`🛰️  delegated council model registered (id=${councilId})\n`);

  const runSearch = (query: string, topK: number): Promise<Hit[]> => searchGraph({ embModelId: embId, workspace: EDGE_WORKSPACE, query, topK, audit });

  console.log("--- council answer (proposer reasoning runs on the hub) ---");
  const result = await runCouncil({ deps: { llmModelId: councilId, runSearch, audit, onToken: write }, question });
  process.stdout.write("\n\n");
  console.log(`📚 sources: ${result.sources.length} · cited: ${result.cited} · verifier: ${result.verifierVerdict.verdict}`);
  console.log(`🧭 trace: ${result.trace.map((s) => (s.step === "search" ? `search(${s.hits}@${s.topScore.toFixed(3)})` : s.step === "verify" ? `verify:${s.verdict}` : `propose#${s.iter}[${s.toolCalls.join(",") || "answer"}]`)).join(" → ")}`);
  audit.record({ event: "note", extra: { role: "edge", question, cited: result.cited, verdict: result.verifierVerdict.verdict, sources: result.sources.length } });

  try {
    await ragCloseWorkspace({ workspace: EDGE_WORKSPACE, deleteOnClose: true });
  } catch {
    /* best effort */
  }
  await unloadEmbeddings(embId, audit);
}

try {
  const cls = classify(question);
  console.log(`🔎 "${question}"  →  classify: ${cls.kind} (${cls.reason})\n`);
  if (cls.kind === "trivial") await runTrivial(question);
  else await runHard(question);
  console.log(`\n✅ done. Audit log: ${audit.path}`);
  void close();
} catch (error) {
  console.error("❌ ask failed:", error);
  audit.record({ event: "note", extra: { role: "edge", error: String(error) } });
  void close();
  process.exit(1);
}
