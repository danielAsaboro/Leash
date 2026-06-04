/**
 * Verification: bundled GGML image classification (food/report/other) as a cheap tag /
 * OCR pre-filter.
 *
 *   npm run senses:classify
 *
 * Classifies two real fixtures (a document-y note vs a sparse card), then ingests the
 * photos dir with the classifier wired in and confirms the `kind:"photo"` node carries
 * its class in `meta`. GO: the note reads "report" (document → OCR worthwhile) and the
 * photo node is tagged.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadClassifier, unloadClassifier, classifyImage, loadOcr, unloadOcr, loadEmbeddings, unloadEmbeddings, ingestNotesDir, GraphStore } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PHOTO_DIR = join(here, "..", "..", "..", "data", "photos");
const NOTE_IMG = join(here, "..", "..", "..", "spike", "fixtures", "ocr-note.png");
const CARD_IMG = join(PHOTO_DIR, "calibration-card.png");
const GRAPH_FILE = join(here, "..", "logs", "classify-graph.jsonl");
const WORKSPACE = "mycelium-classify-smoke";
const audit = new AuditLog("senses-classify", join(here, "..", "logs"));

let clsId: string | undefined;
let ocrId: string | undefined;
let embId: string | undefined;
try {
  console.log("=== GGML image classification (food/report/other) ===\n");
  clsId = await loadClassifier(audit);

  const note = await classifyImage({ classifierModelId: clsId, imagePath: NOTE_IMG, audit });
  const card = await classifyImage({ classifierModelId: clsId, imagePath: CARD_IMG, audit });
  console.log(`📄 ocr-note.png       → ${note.top.label} ${(note.top.confidence * 100).toFixed(0)}%  (isDocument=${note.isDocument})`);
  console.log(`🪪 calibration-card    → ${card.top.label} ${(card.top.confidence * 100).toFixed(0)}%  (isDocument=${card.isDocument})`);
  if (!note.isDocument) throw new Error(`expected the note to classify as a document ("report"), got "${note.top.label}"`);

  // Wire the classifier into ingestion: the photo node should carry its class in meta.
  ocrId = await loadOcr(audit);
  embId = await loadEmbeddings(audit);
  await ingestNotesDir({ notesDir: PHOTO_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: WORKSPACE, photoDir: PHOTO_DIR, ocrModelId: ocrId, classifierModelId: clsId, audit });
  const photoNode = new GraphStore(GRAPH_FILE).all().find((n) => n.kind === "photo");
  console.log(`\n🏷️  photo node meta: ${JSON.stringify(photoNode?.meta)}`);
  if (!photoNode?.meta || typeof photoNode.meta.classification !== "string") throw new Error("photo node was not tagged with a classification in meta");

  console.log(`\n✅ GO — image → classify (${(note.top.confidence * 100).toFixed(0)}% report) → tagged kind:"photo" node. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ classify smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (clsId) await unloadClassifier(clsId, audit);
  if (ocrId) await unloadOcr(ocrId, audit);
  if (embId) await unloadEmbeddings(embId, audit);
}
