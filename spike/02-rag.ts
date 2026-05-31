/**
 * Spike (b) — on-device RAG producing a grounded, cited answer.
 *
 * Ingests local fixture docs, retrieves the relevant chunk for a query that the
 * base model cannot answer from priors (it's about a fictional user "Dani"), and
 * shows the grounded/cited answer differs from the no-context answer.
 *
 * GO criteria: relevant chunk retrieved + grounded/cited answer; retrieval latency logged.
 *
 *   npm run spike:rag
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadModel,
  unloadModel,
  embed,
  completion,
  ragIngest,
  ragSearch,
  ragCloseWorkspace,
  GTE_LARGE_FP16,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("02-rag");
const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "fixtures", "notes");
const WORKSPACE = "mycelium-spike";
const QUERY = "Which model does Dani run on the Raspberry Pi node, and why?";

function loadFixtureDocs(): string[] {
  return readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(NOTES_DIR, f), "utf-8").trim());
}

async function answer(modelId: string, history: { role: string; content: string }[]): Promise<string> {
  const r = completion({ modelId, history, stream: true });
  let out = "";
  for await (const t of r.tokenStream) {
    out += t;
    process.stdout.write(t);
  }
  process.stdout.write("\n");
  return out.trim();
}

let embId: string | undefined;
let llmId: string | undefined;
try {
  console.log("=== (b) On-device RAG ===\n");
  embId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: "embeddings", onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: GTE_LARGE_FP16, modelId: embId });

  const docs = loadFixtureDocs();
  const tIngest = now();
  const ingest = await ragIngest({ modelId: embId, workspace: WORKSPACE, documents: docs, chunk: true });
  audit.record({ event: "rag_ingest", modelSrc: GTE_LARGE_FP16, modelId: embId, tokens: ingest.processed.length, durationMs: now() - tIngest });
  console.log(`Ingested ${docs.length} docs → ${ingest.processed.length} chunks.\n`);

  console.log(`🔎 Query: "${QUERY}"\n`);
  const tSearch = now();
  const hits = await ragSearch({ modelId: embId, workspace: WORKSPACE, query: QUERY, topK: 3 });
  const searchMs = now() - tSearch;
  audit.record({ event: "rag_search", modelSrc: GTE_LARGE_FP16, modelId: embId, durationMs: searchMs, extra: { topK: 3, scores: hits.map((h) => h.score) } });
  console.log(`Retrieved ${hits.length} chunks in ${searchMs}ms:`);
  hits.forEach((h, i) => console.log(`  [${i + 1}] score=${h.score.toFixed(3)}  ${h.content.replace(/\s+/g, " ").slice(0, 90)}…`));

  llmId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llm", onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId: llmId });

  console.log("\n--- NO-CONTEXT answer (base model, no retrieval) ---");
  const noCtx = await answer(llmId, [{ role: "user", content: QUERY }]);
  audit.record({ event: "completion", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId: llmId, prompt: QUERY, extra: { mode: "no-context" } });

  console.log("\n--- GROUNDED answer (RAG context injected, cite sources) ---");
  const context = hits.map((h, i) => `[Source ${i + 1}]\n${h.content}`).join("\n\n");
  const grounded = await answer(llmId, [
    { role: "system", content: `Answer ONLY from the sources below. Cite them as [Source N]. If absent, say you don't know.\n\n${context}` },
    { role: "user", content: QUERY },
  ]);
  audit.record({ event: "completion", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId: llmId, prompt: QUERY, extra: { mode: "grounded", citesSource: /source\s*\d/i.test(grounded), mentionsAnswer: /qwen3?[\s_-]*600m/i.test(grounded) } });

  const cited = /source\s*\d/i.test(grounded);
  const correct = /qwen3?[\s_-]*600m/i.test(grounded.replace(/\s+/g, ""));
  console.log(`\nGrounded answer cites a source: ${cited ? "yes" : "no"} · names the correct model: ${correct ? "yes" : "no"}`);
  console.log(`Differs from no-context answer: ${grounded !== noCtx ? "yes" : "no"}`);
  console.log(`\n✅ GO if the grounded answer retrieved the right chunk, cited it, and beat the no-context answer. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ rag spike failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch {}
  if (llmId) await unloadModel({ modelId: llmId });
  if (embId) await unloadModel({ modelId: embId });
}
