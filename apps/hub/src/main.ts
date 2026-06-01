/**
 * Mycelium hub — the always-on "strong brain" (the Mac).
 *
 *   QVAC_HYPERSWARM_SEED=<64hex> npm run hub
 *
 * Boots an encrypted delegated-inference provider, prints its public key, builds
 * the context graph on the hub, then stays alive serving the council's delegated
 * `completion` calls (the proposer + verifier run here on GPU; the edge orchestrates
 * and does its own light retrieval). A 64-hex seed gives a stable key across restarts.
 */
import { close } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, loadWhisper, unloadWhisper, ingestNotesDir } from "@mycelium/senses";
import { startProvider } from "@mycelium/mesh";
import { NOTES_DIR, VOICE_DIR, GRAPH_FILE, HUB_WORKSPACE, LOG_DIR } from "./config.ts";

const audit = new AuditLog("hub", LOG_DIR);
const seed = process.env["QVAC_HYPERSWARM_SEED"];

try {
  console.log("🍄 Mycelium hub (strong brain / delegated-inference provider)\n");
  const { publicKey } = await startProvider({ seed, audit });
  console.log("📡 Provider public key — give this to the edge:\n");
  console.log(`   ${publicKey}\n`);
  console.log("Edge command (another terminal):");
  console.log(`   npm run ask -- "Which model does Dani run on the Pi, and why?" ${publicKey}\n`);
  if (!seed) console.log("   (set QVAC_HYPERSWARM_SEED=<64hex> for a stable key across restarts)\n");

  // The context graph lives on the always-on hub (Week-2 will CRDT-sync it to every device).
  // Files + transcribed voice memos both become graph nodes.
  const embId = await loadEmbeddings(audit);
  const sttId = await loadWhisper(audit);
  const { nodes, chunks, voiceNodes } = await ingestNotesDir({ notesDir: NOTES_DIR, graphFile: GRAPH_FILE, embModelId: embId, workspace: HUB_WORKSPACE, voiceDir: VOICE_DIR, sttModelId: sttId, audit });
  console.log(`🧠 Context graph ready on the hub: ${nodes} nodes (${voiceNodes} voice) → ${chunks} chunks.`);
  await unloadWhisper(sttId, audit);
  await unloadEmbeddings(embId, audit);

  console.log("\n✅ Hub ready — serving delegated council inference. Press Ctrl-C to stop.");
  process.on("SIGINT", () => {
    audit.record({ event: "note", extra: { role: "hub", stopped: true } });
    console.log("\n🛑 hub stopped");
    void close();
    process.exit(0);
  });
  process.stdin.resume();
} catch (error) {
  console.error("❌ hub failed:", error);
  audit.record({ event: "note", extra: { role: "hub", error: String(error) } });
  process.exit(1);
}
