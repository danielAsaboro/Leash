/**
 * Smoke: adapter distribution over the REAL Hyperswarm (two processes, two stores).
 *
 *   # terminal A (publisher / "hub"):
 *   npx tsx packages/mesh/scripts/smoke-adapter-mesh.ts publish <storeDir> <inviteFile>
 *   # terminal B (fetcher / "peer"):
 *   npx tsx packages/mesh/scripts/smoke-adapter-mesh.ts fetch <storeDir> <inviteFile> <destDir>
 *
 * Unlike the single-process smokes, this exercises the genuinely-untested link: the
 * feed core replicating peer-to-peer over the swarm. The publisher founds a mesh,
 * mints an invite, publishes a random adapter, and stays alive to SEED. The fetcher
 * pairs against the invite, waits for the pointer to replicate, then fetches +
 * sha256-verifies. Same machine or two — the swarm transport is identical.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { MeshGraph } from "../src/index.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const [mode, storeDir, inviteFile, destDir] = process.argv.slice(2);

async function publish(): Promise<void> {
  if (!storeDir || !inviteFile) throw new Error("usage: publish <storeDir> <inviteFile>");
  const g = await MeshGraph.open({ storeDir });
  await g.joinSwarm();
  const invite = await g.mintInvite();
  mkdirSync(dirname(inviteFile), { recursive: true });

  // A real adapter blob written to a temp gguf, then published over the mesh.
  const blob = randomBytes(600 * 1024);
  const ggufPath = `${storeDir}.adapter.gguf`;
  writeFileSync(ggufPath, blob);
  const version = "20260608-mesh01";
  const meta = await g.publishAdapter({ ggufPath, version, baseModel: "QWEN3_4B_INST_Q4_K_M", evalDelta: 0.077 });
  console.log(`PUBLISHED version=${version} sha256=${meta.sha256} bytes=${meta.sizeBytes} feed=${meta.feedKey.slice(0, 12)}…`);

  // Write the invite LAST — its presence signals "publisher ready" to the fetcher.
  writeFileSync(inviteFile, invite);
  console.log(`SEEDING — invite written to ${inviteFile}. Staying alive (Ctrl-C / SIGTERM to stop).`);

  const stop = async () => { await g.close().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  await new Promise<never>(() => {}); // seed until killed
}

async function fetchPeer(): Promise<void> {
  if (!storeDir || !inviteFile || !destDir) throw new Error("usage: fetch <storeDir> <inviteFile> <destDir>");

  // Wait (bounded) for the publisher to write the invite.
  const inviteDeadline = Date.now() + 60_000;
  while (!existsSync(inviteFile) && Date.now() < inviteDeadline) await sleep(500);
  if (!existsSync(inviteFile)) throw new Error("publisher never wrote the invite (60s)");
  const invite = readFileSync(inviteFile, "utf-8").trim();

  console.log("pairing against the invite…");
  const g = await MeshGraph.pair({ storeDir, invite, timeoutMs: 60_000 });
  console.log("paired — waiting for the adapter pointer to replicate…");

  // Bounded wait for the pointer to arrive over the CRDT.
  const ptrDeadline = Date.now() + 60_000;
  let meta = await g.latestAdapter();
  while (!meta && Date.now() < ptrDeadline) {
    await sleep(750);
    await g.update();
    meta = await g.latestAdapter();
  }
  if (!meta) {
    await g.close();
    throw new Error("adapter pointer never replicated (60s)");
  }
  console.log(`pointer received: version=${meta.version} sha256=${meta.sha256.slice(0, 16)}… — fetching bytes over the swarm…`);

  const fetched = await g.fetchLatestAdapter({ destDir, timeoutMs: 60_000 });
  if (!fetched) {
    await g.close();
    throw new Error("fetchLatestAdapter returned null");
  }
  const got = readFileSync(fetched.ggufPath);
  const ok = sha(got) === meta.sha256;
  console.log(`FETCHED version=${fetched.version} sha256=${sha(got)} bytes=${got.length} → ${ok ? "✅ MATCH" : "❌ MISMATCH"}`);
  await g.close();
  if (!ok) process.exit(1);
  console.log("🟢 PASS — adapter replicated over the live swarm, sha256 verified");
}

try {
  if (mode === "publish") await publish();
  else if (mode === "fetch") await fetchPeer();
  else throw new Error("mode must be 'publish' or 'fetch'");
} catch (err) {
  console.error("🔴 FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
}
