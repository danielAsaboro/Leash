/**
 * Mycelium hub — the always-on "strong brain" (the Mac).
 *
 *   QVAC_HYPERSWARM_SEED=<64hex> [MESH_GRAPH_SEED=<64hex>] npm run hub
 *
 * Boots an encrypted delegated-inference provider, prints its public key, opens the
 * replicated Autobase context graph (Week-2 CRDT — not a per-query rebuild), mints a
 * blind-pairing invite (printed + written to data/invite.txt), additively seeds the
 * graph from data/, embeds the current view, and stays alive: serving delegated
 * council `completion` calls AND live-embedding any node an edge syncs in (onChange).
 * The hub accretes, never destroys.
 */
import { writeFileSync } from "node:fs";
import { close } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, loadWhisper, unloadWhisper, seedFromDataDir, embedDelta, loadEmbeddedIds, saveEmbeddedIds } from "@mycelium/senses";
import { startProvider, MeshGraph } from "@mycelium/mesh";
import { NOTES_DIR, VOICE_DIR, HUB_WORKSPACE, LOG_DIR, MESH_STORE_DIR, INVITE_FILE, EMBEDDED_IDS_FILE } from "./config.ts";

const audit = new AuditLog("hub", LOG_DIR);
const seed = process.env["QVAC_HYPERSWARM_SEED"];
const meshSeed = process.env["MESH_GRAPH_SEED"];

try {
  console.log("🍄 Mycelium hub (strong brain / delegated-inference provider)\n");

  // Open the replicated context graph FIRST (our Corestore must claim its rocksdb
  // before the SDK's Bare worker opens its own corestore — opening the SDK provider
  // first trips the device-file check; spike proved our-store-before-SDK is the safe
  // order). This device is the founding writer of the one mesh.
  const graph = await MeshGraph.open({ storeDir: MESH_STORE_DIR, seed: meshSeed, audit });
  await graph.joinSwarm();
  const invite = await graph.mintInvite();
  writeFileSync(INVITE_FILE, invite);

  const { publicKey } = await startProvider({ seed, audit });
  console.log("📡 Provider public key — give this to the edge:\n");
  console.log(`   ${publicKey}\n`);
  console.log("🔗 Mesh invite (also written to data/invite.txt):\n");
  console.log(`   ${invite}\n`);
  console.log("Edge command (another terminal):");
  console.log(`   npm run ask -- "Which model does Dani run on the Pi, and why?" ${publicKey} ${invite}\n`);

  // Advertise THIS device's capability over the mesh so edges can discover us as a
  // provider without a hard-coded pubkey (Part A — capability-registry gossip).
  await graph.advertise({
    deviceId: graph.localWriterKey, displayName: "mycelium-hub", computeClass: "mac", ramMB: 65536,
    powerState: "plugged", availableModels: ["QWEN3_4B_INST_Q4_K_M", "GTE_LARGE_FP16", "WHISPER_BASE_Q8_0"],
    isProvider: true, providerPublicKey: publicKey, lastSeen: new Date().toISOString(),
  });

  // Embeddings + STT to build/maintain the vector index over the graph.
  const embId = await loadEmbeddings(audit);
  const sttId = await loadWhisper(audit);
  const seeded = await seedFromDataDir({ graph, notesDir: NOTES_DIR, voiceDir: VOICE_DIR, sttModelId: sttId, audit });
  await unloadWhisper(sttId, audit);

  const embedded = loadEmbeddedIds(EMBEDDED_IDS_FILE);
  const initial = await embedDelta({ embModelId: embId, workspace: HUB_WORKSPACE, nodes: await graph.all(), embedded, audit });
  saveEmbeddedIds(EMBEDDED_IDS_FILE, embedded);
  console.log(`🧠 Context graph ready: ${(await graph.all()).length} nodes (seeded ${seeded.added}); embedded ${initial.added} new, ${initial.skipped} cached.`);

  // Live-embed nodes an edge syncs in, so edge→hub queries work without a restart.
  graph.onChange(async (nodes) => {
    const delta = await embedDelta({ embModelId: embId, workspace: HUB_WORKSPACE, nodes, embedded, audit });
    if (delta.added > 0) {
      saveEmbeddedIds(EMBEDDED_IDS_FILE, embedded);
      console.log(`🔄 embedded ${delta.added} edge-synced node(s).`);
    }
  });

  console.log("\n✅ Hub ready — serving delegated council inference + live graph sync. Ctrl-C to stop.");
  process.on("SIGINT", () => {
    void (async () => {
      audit.record({ event: "note", extra: { role: "hub", stopped: true } });
      saveEmbeddedIds(EMBEDDED_IDS_FILE, embedded);
      await graph.close();
      await unloadEmbeddings(embId, audit);
      console.log("\n🛑 hub stopped");
      void close();
      process.exit(0);
    })();
  });
  process.stdin.resume();
} catch (error) {
  console.error("❌ hub failed:", error);
  audit.record({ event: "note", extra: { role: "hub", error: String(error) } });
  process.exit(1);
}
