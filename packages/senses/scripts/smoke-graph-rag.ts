/**
 * Verification (build sequence step 3): GraphStore + RAG index over local files.
 *
 *   npm run senses:smoke
 *
 * Ingests spike/fixtures/notes/*.md as `kind:"file"` graph nodes, indexes them,
 * and searches. GO: nodes round-trip through the JSONL store, and searchGraph
 * returns scored hits reproducing the spike's ~0.768-class top score.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { GraphStore, loadEmbeddings, unloadEmbeddings, ingestNodes, searchGraph } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "..", "..", "..", "spike", "fixtures", "notes");
const STORE_FILE = join(here, "..", "logs", "graph-smoke.jsonl");
const WORKSPACE = "mycelium-senses-smoke";
const QUERY = "Which model does Dani run on the Raspberry Pi node, and why?";
const audit = new AuditLog("senses-smoke", join(here, "..", "logs"));

let embId: string | undefined;
try {
  console.log("=== Step 3 — GraphStore + RAG index over local files ===\n");

  // Fresh store each run so the round-trip count is deterministic.
  rmSync(STORE_FILE, { force: true });
  const store = new GraphStore(STORE_FILE);
  for (const f of readdirSync(NOTES_DIR).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(join(NOTES_DIR, f), "utf-8").trim();
    store.append({ kind: "file", source: join("spike/fixtures/notes", f), text });
  }
  const nodes = store.all();
  console.log(`GraphStore: appended + read back ${nodes.length} file nodes from ${store.path}`);
  if (nodes.length === 0) throw new Error("no nodes round-tripped through the GraphStore");

  embId = await loadEmbeddings(audit);
  const chunks = await ingestNodes({ embModelId: embId, workspace: WORKSPACE, nodes, audit });
  console.log(`Indexed ${nodes.length} nodes → ${chunks} chunks.\n`);

  console.log(`🔎 Query: "${QUERY}"`);
  const hits = await searchGraph({ embModelId: embId, workspace: WORKSPACE, query: QUERY, topK: 3, audit });
  hits.forEach((h, i) =>
    console.log(`  [${i + 1}] score=${h.score.toFixed(3)}  ${h.content.replace(/\s+/g, " ").slice(0, 80)}…`),
  );

  const top = hits[0]?.score ?? 0;
  const namesModel = hits.some((h) => /qwen3?[\s_-]*600m/i.test(h.content.replace(/\s+/g, "")));
  console.log(`\nTop score ${top.toFixed(3)} (spike class ~0.768) · a hit names QWEN3_600M: ${namesModel ? "yes" : "no"}`);
  if (top < 0.6 || !namesModel) throw new Error("retrieval did not surface the expected chunk — step 3 FAILED");
  console.log(`\n✅ GO — graph nodes indexed and retrieved with scored hits. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ senses smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (embId) await unloadEmbeddings(embId, audit);
}
