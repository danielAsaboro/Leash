/**
 * Verification: Parakeet diarization (who-spoke-when) → speaker-attributed voice node.
 *
 *   npm run senses:diarize
 *
 * Diarizes a real 2-speaker synthesized standup (Sortformer) + transcribes each turn
 * (TDT), ingests it as a speaker-attributed kind:"voice" node, and shows the attributed
 * transcript is retrievable. GO: ≥2 speakers detected, the spoken facts survive, and a
 * "Speaker N: …" chunk is retrieved.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, loadDiarizer, loadTranscriber, unloadParakeet, diarizeFile, ingestNotesDir, searchGraph } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(here, "fixtures");
const WAV = join(FIX_DIR, "standup-2spk.wav");
const GRAPH_FILE = join(here, "..", "logs", "diarize-graph.jsonl");
const WORKSPACE = "mycelium-diarize-smoke";
const QUESTION = "What did the standup say about the backup battery?";
const audit = new AuditLog("senses-diarize", join(here, "..", "logs"));

let diarId: string | undefined;
let tdtId: string | undefined;
let embId: string | undefined;
try {
  console.log("=== Parakeet diarization → speaker-attributed voice node ===\n");

  diarId = await loadDiarizer(audit);
  tdtId = await loadTranscriber(audit);
  const { text, segments, speakers } = await diarizeFile({ diarizerModelId: diarId, transcriberModelId: tdtId, audioPath: WAV, audit });
  console.log(`🗣️  ${speakers} speaker(s), ${segments.length} merged turn(s):`);
  for (const s of segments) console.log(`   Speaker ${s.speaker} (${s.start.toFixed(1)}s–${s.end.toFixed(1)}s): ${s.text}`);

  if (speakers < 2) throw new Error(`expected ≥2 speakers, got ${speakers}`);
  if (!/hour/i.test(text)) throw new Error(`spoken fact (battery hours) missing from transcript: "${text}"`);

  // Ingest the diarized memo as a speaker-attributed voice node, then retrieve it.
  embId = await loadEmbeddings(audit);
  const { voiceNodes } = await ingestNotesDir({ notesDir: FIX_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: WORKSPACE, voiceDir: FIX_DIR, diarizerModelId: diarId, transcriberModelId: tdtId, audit });
  if (voiceNodes < 1) throw new Error("no diarized voice node was ingested");
  await unloadParakeet(diarId, audit); diarId = undefined;
  await unloadParakeet(tdtId, audit); tdtId = undefined;

  console.log(`\n🔎 "${QUESTION}"`);
  const hits = await searchGraph({ embModelId: embId, workspace: WORKSPACE, query: QUESTION, topK: 3, audit });
  hits.forEach((h, i) => console.log(`  [${i + 1}] score=${h.score.toFixed(3)}  ${h.content.replace(/\s+/g, " ").slice(0, 90)}…`));
  if (!hits.some((h) => /Speaker \d/.test(h.content))) throw new Error("no speaker-attributed chunk was retrieved");

  console.log(`\n✅ GO — audio → diarize (who-spoke-when) → TDT transcribe → attributed voice node → retrievable. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ diarize smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (diarId) await unloadParakeet(diarId, audit);
  if (tdtId) await unloadParakeet(tdtId, audit);
  if (embId) await unloadEmbeddings(embId, audit);
}
