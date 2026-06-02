/**
 * Verification (Part D): photo ingestion via on-device OCR.
 *
 *   npm run senses:photo
 *
 * OCRs a real fixture image (a fact NOT in the text notes/voice), ingests it as a
 * kind:"photo" graph node, and shows the photo-derived fact is retrievable. GO: the
 * OCR text is sane and a photo chunk is retrieved for a question only the image answers.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, loadOcr, unloadOcr, ocrFile, ingestNotesDir, searchGraph } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "..", "..", "..", "data", "notes");
const PHOTO_DIR = join(here, "..", "..", "..", "data", "photos");
const IMG = join(PHOTO_DIR, "calibration-card.png");
const GRAPH_FILE = join(here, "..", "logs", "photo-graph.jsonl");
const WORKSPACE = "mycelium-photo-smoke";
const QUESTION = "When was the greenhouse sensor last calibrated?";
const audit = new AuditLog("senses-photo", join(here, "..", "logs"));
const hasFact = (s: string) => /2026-05-28|may 28|calibrat/i.test(s);

let ocrId: string | undefined;
let embId: string | undefined;
try {
  console.log("=== Part D — photo ingestion via on-device OCR ===\n");

  ocrId = await loadOcr(audit);
  const text = await ocrFile({ ocrModelId: ocrId, imagePath: IMG, audit });
  console.log(`🖼️  OCR text: "${text}"`);
  if (!hasFact(text)) throw new Error(`OCR missing the calibration fact: "${text}"`);

  embId = await loadEmbeddings(audit);
  const { nodes, chunks, photoNodes } = await ingestNotesDir({ notesDir: NOTES_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: WORKSPACE, photoDir: PHOTO_DIR, ocrModelId: ocrId, audit });
  console.log(`Indexed ${nodes} nodes (${photoNodes} photo) → ${chunks} chunks.\n`);
  if (photoNodes < 1) throw new Error("no photo node was ingested");
  await unloadOcr(ocrId, audit);
  ocrId = undefined;

  console.log(`🔎 "${QUESTION}"`);
  const hits = await searchGraph({ embModelId: embId, workspace: WORKSPACE, query: QUESTION, topK: 3, audit });
  hits.forEach((h, i) => console.log(`  [${i + 1}] score=${h.score.toFixed(3)}  ${h.content.replace(/\s+/g, " ").slice(0, 80)}…`));
  if (!hits.some((h) => hasFact(h.content))) throw new Error("the photo fact was not retrieved from the graph");

  console.log(`\n✅ GO — image → OCR → kind:"photo" graph node → retrievable. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ photo smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch {}
  if (ocrId) await unloadOcr(ocrId, audit);
  if (embId) await unloadEmbeddings(embId, audit);
}
