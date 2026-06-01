/**
 * Hub graph ingest CLI.
 *
 *   npm run hub:ingest
 *
 * (Re)builds the hub's context graph from data/notes/*.md into the vector
 * workspace. `npm run hub` also does this on boot; this CLI is for rebuilding the
 * graph without restarting the provider.
 */
import { close } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, ingestNotesDir } from "@mycelium/senses";
import { NOTES_DIR, GRAPH_FILE, HUB_WORKSPACE, LOG_DIR } from "./config.ts";

const audit = new AuditLog("hub-ingest", LOG_DIR);
try {
  const embId = await loadEmbeddings(audit);
  const { nodes, chunks } = await ingestNotesDir({ notesDir: NOTES_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: HUB_WORKSPACE, audit });
  console.log(`🧠 Ingested ${nodes} notes → ${chunks} chunks into workspace '${HUB_WORKSPACE}'.`);
  await unloadEmbeddings(embId, audit);
  await close();
} catch (error) {
  console.error("❌ hub ingest failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exit(1);
}
