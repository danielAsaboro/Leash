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
import { loadEmbeddings, unloadEmbeddings, loadWhisper, unloadWhisper, loadOcr, unloadOcr, seedFromDataDir, embedDelta, loadEmbeddedIds, saveEmbeddedIds } from "@mycelium/senses";
import { startProvider, MeshGraph, startHeartbeat } from "@mycelium/mesh";
import { startAdapterSync } from "./adapter-sync.ts";
import { NOTES_DIR, VOICE_DIR, PHOTOS_DIR, HUB_WORKSPACE, LOG_DIR, MESH_STORE_DIR, INVITE_FILE, EMBEDDED_IDS_FILE, loadAllowlist } from "./config.ts";

const audit = new AuditLog("hub", LOG_DIR);
const seed = process.env["QVAC_HYPERSWARM_SEED"];
const meshSeed = process.env["MESH_GRAPH_SEED"];

try {
  console.log("🍄 Mycelium hub (strong brain / delegated-inference provider)\n");

  // Open the replicated context graph FIRST (our Corestore must claim its rocksdb
  // before the SDK's Bare worker opens its own corestore — opening the SDK provider
  // first trips the device-file check; spike proved our-store-before-SDK is the safe
  // order). This device is the founding writer of the one mesh.
  // Pairing allow-list (Part C): if set, only these device writer-keys may pair into
  // the mesh. Empty/absent = open (existing demos still pair).
  const allowedDevices = loadAllowlist();
  if (allowedDevices.size > 0) console.log(`🔒 pairing allow-list active: ${allowedDevices.size} trusted device(s)`);
  const graph = await MeshGraph.open({ storeDir: MESH_STORE_DIR, seed: meshSeed, audit, allowedDevices });
  await graph.joinSwarm();
  const invite = await graph.mintInvite();
  writeFileSync(INVITE_FILE, invite);

  // Delegation firewall is a SEPARATE key-space (QVAC consumer pubkeys, not mesh writer-
  // keys), so it's wired from its own MYCELIUM_TRUSTED_CONSUMERS env, not the pairing
  // allow-list. Unset = open delegation (back-compat).
  const trustedConsumer = process.env["MYCELIUM_TRUSTED_CONSUMERS"]?.split(",")[0]?.trim() || undefined;
  if (trustedConsumer) console.log(`🔒 delegation firewall active: consumer ${trustedConsumer.slice(0, 16)}…`);
  const { publicKey } = await startProvider({ seed, audit, allowedConsumer: trustedConsumer });
  console.log("📡 Provider public key — give this to the edge:\n");
  console.log(`   ${publicKey}\n`);
  console.log("🔗 Mesh invite (also written to data/invite.txt):\n");
  console.log(`   ${invite}\n`);
  console.log("Edge command (another terminal):");
  console.log(`   npm run ask -- "Which model does Dani run on the Pi, and why?" ${publicKey} ${invite}\n`);

  // Heartbeat THIS device's capability over the mesh so edges can discover us as a
  // provider without a hard-coded pubkey AND tell we're still alive (Part A gossip +
  // Part B failover: a fresh lastSeen every 10s; a killed hub goes stale → edges fail over).
  const heartbeat = startHeartbeat(graph, {
    deviceId: graph.localWriterKey, displayName: "mycelium-hub", computeClass: "mac", ramMB: 65536,
    powerState: "plugged", availableModels: ["QWEN3_4B_INST_Q4_K_M", "GTE_LARGE_FP16", "WHISPER_BASE_Q8_0"],
    isProvider: true, providerPublicKey: publicKey,
  }, 10_000);

  // Embeddings + STT to build/maintain the vector index over the graph.
  const embId = await loadEmbeddings(audit);
  const sttId = await loadWhisper(audit);
  const ocrId = await loadOcr(audit);
  const seeded = await seedFromDataDir({ graph, notesDir: NOTES_DIR, voiceDir: VOICE_DIR, sttModelId: sttId, photoDir: PHOTOS_DIR, ocrModelId: ocrId, audit });
  await unloadWhisper(sttId, audit);
  await unloadOcr(ocrId, audit);

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

  // Layer-4 (opt-in): share trained LoRA adapters over the mesh. The hub owns the
  // single-process mesh-store + swarm and stays alive, so publish/fetch live here.
  // Enable with MYCELIUM_ADAPTER_SYNC=1 on every device you want in the loop.
  const adapterSync = process.env["MYCELIUM_ADAPTER_SYNC"] ? startAdapterSync(graph, { audit }) : null;

  console.log("\n✅ Hub ready — serving delegated council inference + live graph sync. Ctrl-C to stop.");
  process.on("SIGINT", () => {
    void (async () => {
      audit.record({ event: "note", extra: { role: "hub", stopped: true } });
      adapterSync?.stop();
      heartbeat.stop();
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
