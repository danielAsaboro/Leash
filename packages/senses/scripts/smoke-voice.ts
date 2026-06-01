/**
 * Verification (build sequence step 6): voice ingestion via whisper STT.
 *
 *   npm run senses:voice
 *
 * Transcribes a real .wav memo (a fact NOT in the text notes), ingests it as a
 * kind:"voice" graph node, and shows the spoken fact is retrievable from the
 * graph. GO: the transcript is sane and a voice-derived chunk is retrieved for a
 * question the text notes can't answer. ("Answerable by the council" is then shown
 * end-to-end by the two-process demo with a voice question.)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ragCloseWorkspace } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, loadWhisper, unloadWhisper, transcribeFile, ingestNotesDir, searchGraph } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "..", "..", "..", "data", "notes");
const VOICE_DIR = join(here, "..", "..", "..", "data", "voice");
const WAV = join(VOICE_DIR, "dani-backup-memo.wav");
const GRAPH_FILE = join(here, "..", "logs", "voice-graph.jsonl");
const WORKSPACE = "mycelium-voice-smoke";
const QUESTION = "How long does the Raspberry Pi emergency backup battery last?";
const audit = new AuditLog("senses-voice", join(here, "..", "logs"));
const hasFact = (s: string) => /twelve|12\b/i.test(s) && /hour/i.test(s);

let sttId: string | undefined;
let embId: string | undefined;
try {
  console.log("=== Step 6 — voice ingestion via whisper STT ===\n");

  sttId = await loadWhisper(audit);
  const transcript = await transcribeFile({ sttModelId: sttId, audioPath: WAV, audit });
  console.log(`🎙️  transcript: "${transcript}"`);
  if (!hasFact(transcript)) throw new Error(`whisper transcript missing the spoken fact (twelve hours): "${transcript}"`);

  embId = await loadEmbeddings(audit);
  const { nodes, chunks, voiceNodes } = await ingestNotesDir({ notesDir: NOTES_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: WORKSPACE, voiceDir: VOICE_DIR, sttModelId: sttId, audit });
  console.log(`Indexed ${nodes} nodes (${voiceNodes} voice) → ${chunks} chunks.\n`);
  if (voiceNodes < 1) throw new Error("no voice node was ingested");
  await unloadWhisper(sttId, audit);
  sttId = undefined;

  console.log(`🔎 "${QUESTION}"`);
  const hits = await searchGraph({ embModelId: embId, workspace: WORKSPACE, query: QUESTION, topK: 3, audit });
  hits.forEach((h, i) => console.log(`  [${i + 1}] score=${h.score.toFixed(3)}  ${h.content.replace(/\s+/g, " ").slice(0, 80)}…`));
  if (!hits.some((h) => hasFact(h.content))) throw new Error("the voice fact was not retrieved from the graph");

  console.log(`\n✅ GO — voice → STT → kind:"voice" graph node → retrievable. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ voice smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (sttId) await unloadWhisper(sttId, audit);
  if (embId) await unloadEmbeddings(embId, audit);
}
