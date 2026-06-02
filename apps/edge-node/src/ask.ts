/**
 * Mycelium edge node — the weak consumer (the "phone").
 *
 *   npm run ask -- "<question>" [<hub-public-key>] [<mesh-invite>]
 *
 * The router decides:
 *   - TRIVIAL → answered locally by the small QWEN3_600M model. No hub, no graph.
 *   - HARD    → the edge keeps a REPLICATED context graph (Week-2 CRDT Autobase,
 *               synced P2P from the hub — no shared files), does its own light
 *               retrieval, and delegates the heavy council reasoning (QWEN3_4B
 *               proposer + verifier) to the hub over encrypted P2P.
 *
 * Audit trail for a hard query: pairing? → graph_sync → delegation → rag_search →
 * completion(proposer) → completion(verifier) → note.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { close } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, loadWhisper, unloadWhisper, transcribeFile, searchGraph, embedDelta, loadEmbeddedIds, saveEmbeddedIds, QWEN3_4B_INST_Q4_K_M, type Hit } from "@mycelium/senses";
import { classify, answerTrivial, runCouncil } from "@mycelium/mind";
import { loadDelegated, MeshGraph, CapabilityRegistry } from "@mycelium/mesh";
import { VOICE_DIR, MESH_STORE_DIR, INVITE_FILE, EMBEDDED_IDS_FILE, EDGE_WORKSPACE, LOG_DIR } from "./config.ts";

const question = process.argv[2];
const hubPublicKey = process.argv[3];
const inviteArg = process.argv[4];
if (!question) {
  console.error('usage: npm run ask -- "<question>" [<hub-public-key>] [<mesh-invite>]');
  process.exit(1);
}
const audit = new AuditLog("edge-node", LOG_DIR);
const write = (t: string) => process.stdout.write(t);

async function runTrivial(question: string): Promise<void> {
  console.log("🟢 router → TRIVIAL (local QWEN3_600M)\n");
  process.stdout.write("answer: ");
  await answerTrivial({ question, audit, onToken: write });
  process.stdout.write("\n");
}

function resolveInvite(): string | undefined {
  if (inviteArg) return inviteArg;
  if (existsSync(INVITE_FILE)) return readFileSync(INVITE_FILE, "utf-8").trim();
  return undefined;
}

/** Open the replicated graph: reopen if this device already paired (permanent writer), else pair. */
async function openGraph(): Promise<MeshGraph> {
  if (existsSync(MESH_STORE_DIR)) {
    const graph = await MeshGraph.open({ storeDir: MESH_STORE_DIR, audit });
    await graph.joinSwarm();
    return graph;
  }
  const invite = resolveInvite();
  if (!invite) throw new Error("first run needs a mesh invite: pass it as the 3rd arg, or start the hub (which writes data/invite.txt)");
  return MeshGraph.pair({ storeDir: MESH_STORE_DIR, invite, audit }); // pair() joins the swarm
}

async function runHard(question: string): Promise<void> {
  console.log(`🔴 router → HARD (delegated council)\n`);

  // Open the replicated graph FIRST (mirrors the hub's store-before-models order).
  const graph = await openGraph();
  // Bounded best-effort replication wait — returns fast offline (R6).
  await graph.sync();

  // Advertise this edge, then discover a provider from the gossiped registry
  // (Part A). Falls back to an explicitly-passed hub pubkey for back-compat.
  await graph.advertise({
    deviceId: graph.localWriterKey, displayName: "mycelium-edge", computeClass: "phone", ramMB: 6144,
    powerState: "battery", availableModels: ["QWEN3_600M_INST_Q4"], isProvider: false,
    lastSeen: new Date().toISOString(),
  });
  // On a cold pair the hub's cap entry lands a few seconds after pairing (sync()
  // only settles on node count, not cap:* entries), so poll the replicated registry
  // up to 20s for a provider. An explicitly-passed hub pubkey short-circuits the wait.
  const reg = new CapabilityRegistry();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const tWait = Date.now();
  do {
    (await graph.capabilities()).forEach((c) => reg.register(c));
    if (hubPublicKey || reg.bestProvider()) break;
    await sleep(500);
  } while (Date.now() - tWait < 20_000);
  const advertised = reg.bestProvider();
  // `||` (not `??`): a blank/empty pubkey arg must fall through to gossip discovery.
  const providerKey = hubPublicKey || advertised?.providerPublicKey;
  if (!providerKey) {
    console.error("❌ no provider known (pass a hub pubkey or wait for capability gossip)");
    process.exit(1);
  }
  console.log(`🛰️  provider selected: ${providerKey.slice(0, 16)}… ${advertised ? `(gossiped: ${advertised.displayName})` : "(arg)"}`);

  const embId = await loadEmbeddings(audit);

  // The edge is also a sensor: append its own voice memos (edge→hub path). Additive.
  const sttId = await loadWhisper(audit);
  const known = new Set((await graph.all()).map((n) => n.source));
  if (existsSync(VOICE_DIR)) {
    for (const f of readdirSync(VOICE_DIR).filter((n) => n.endsWith(".wav"))) {
      const source = join("data/voice", basename(f));
      if (known.has(source)) continue;
      const text = await transcribeFile({ sttModelId: sttId, audioPath: join(VOICE_DIR, f), audit });
      if (text) await graph.append({ kind: "voice", source, text, meta: { transcribed: true, sensedBy: "edge" } });
    }
  }
  await unloadWhisper(sttId, audit);

  // Embed only the delta into the local workspace (persisted across runs).
  const embedded = loadEmbeddedIds(EMBEDDED_IDS_FILE);
  const nodes = await graph.all();
  const delta = await embedDelta({ embModelId: embId, workspace: EDGE_WORKSPACE, nodes, embedded, audit });
  saveEmbeddedIds(EMBEDDED_IDS_FILE, embedded);
  console.log(`🧩 replicated graph: ${nodes.length} nodes (embedded ${delta.added} new, ${delta.skipped} cached)`);

  // Heavy council reasoning is delegated to the hub (UNCHANGED from Week-1).
  const councilId = await loadDelegated({ modelSrc: QWEN3_4B_INST_Q4_K_M, providerPublicKey: providerKey, audit });
  console.log(`🛰️  delegated council model registered (id=${councilId})\n`);

  const runSearch = (query: string, topK: number): Promise<Hit[]> => searchGraph({ embModelId: embId, workspace: EDGE_WORKSPACE, query, topK, audit });

  console.log("--- council answer (proposer reasoning runs on the hub) ---");
  const result = await runCouncil({ deps: { llmModelId: councilId, runSearch, audit, onToken: write }, question });
  process.stdout.write("\n\n");
  console.log(`📚 sources: ${result.sources.length} · cited: ${result.cited} · verifier: ${result.verifierVerdict.verdict}`);
  console.log(`🧭 trace: ${result.trace.map((s) => (s.step === "search" ? `search(${s.hits}@${s.topScore.toFixed(3)})` : s.step === "verify" ? `verify:${s.verdict}` : `propose#${s.iter}[${s.toolCalls.join(",") || "answer"}]`)).join(" → ")}`);
  audit.record({ event: "note", extra: { role: "edge", question, cited: result.cited, verdict: result.verifierVerdict.verdict, sources: result.sources.length } });

  // Keep the workspace + embedded-ids in lockstep across runs — do NOT delete it.
  await graph.close();
  await unloadEmbeddings(embId, audit);
}

try {
  const cls = classify(question);
  console.log(`🔎 "${question}"  →  classify: ${cls.kind} (${cls.reason})\n`);
  if (cls.kind === "trivial") await runTrivial(question);
  else await runHard(question);
  console.log(`\n✅ done. Audit log: ${audit.path}`);
  void close();
} catch (error) {
  console.error("❌ ask failed:", error);
  audit.record({ event: "note", extra: { role: "edge", error: String(error) } });
  void close();
  process.exit(1);
}
