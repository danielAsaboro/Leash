/**
 * Smoke: the hub's adapter-sync wrapper (publish + fetch passes), end to end.
 *
 *   npx tsx apps/hub/scripts/smoke-adapter-sync.ts
 *
 * Single-process, OFFLINE. Exercises the REAL `syncAdaptersOnce` code the live hub
 * runs: drop a fake (but real-on-disk) promotable adapter in a "trainer" adapters
 * dir → one pass PUBLISHES it (pointer lands on the CRDT, bytes on the feed) → a
 * second pass against an EMPTY "peer" adapters dir FETCHES it back from the same
 * store → assert byte-identical (sha256) + the manifest + the publish guard.
 *
 * GO when publish/fetch round-trip the bytes and a re-pass is a no-op (no republish).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { MeshGraph } from "@mycelium/mesh";
import { syncAdaptersOnce } from "../src/adapter-sync.ts";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "..", "logs", "adapter-sync-smoke");
const storeDir = join(base, "store");
const trainerAdapters = join(base, "trainer", "adapters");
const peerAdapters = join(base, "peer", "adapters");

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}
const cleanup = () => rmSync(base, { recursive: true, force: true });

try {
  cleanup();
  // A real on-disk "trained" adapter: gguf bytes + a promotable manifest (evalDelta>=0).
  const version = "20260608-120000";
  const blob = randomBytes(640 * 1024);
  const srcSha = sha(blob);
  mkdirSync(join(trainerAdapters, version), { recursive: true });
  writeFileSync(join(trainerAdapters, version, "adapter.gguf"), blob);
  writeFileSync(
    join(trainerAdapters, version, "manifest.json"),
    JSON.stringify({ version, baseModel: "QWEN3_4B_INST_Q4_K_M", adapterFile: "adapter.gguf", sha256: srcSha, sizeBytes: blob.length, trainPairs: 137, evalDelta: 0.083 }, null, 2),
  );

  const g = await MeshGraph.open({ storeDir, swarm: false });
  const publishedThisSession = new Set<string>();

  // PASS 1 — trainer side: should PUBLISH.
  const r1 = await syncAdaptersOnce(g, { adaptersDir: trainerAdapters, publishedThisSession });
  expect("pass 1 publishes the local promotable adapter", r1.published === version);
  expect("the pointer is on the CRDT (latestAdapter)", (await g.latestAdapter())?.version === version);

  // PASS 2 — trainer side again: must NOT republish (idempotent guard).
  const r2 = await syncAdaptersOnce(g, { adaptersDir: trainerAdapters, publishedThisSession });
  expect("pass 2 is a no-op (no republish)", r2.published === undefined);

  // PASS 3 — peer side: empty adapters dir → should FETCH from the same store/feed.
  const r3 = await syncAdaptersOnce(g, { adaptersDir: peerAdapters });
  expect("peer pass fetches the adapter", r3.fetched === version);
  const got = join(peerAdapters, version, "adapter.gguf");
  expect("fetched gguf written to peer dir", existsSync(got));
  expect("fetched bytes are byte-identical (sha256)", sha(readFileSync(got)) === srcSha);
  expect("fetched manifest mentions the version", readFileSync(join(peerAdapters, version, "manifest.json"), "utf-8").includes(version));

  // PASS 4 — peer side again: now has it locally → no-op.
  const r4 = await syncAdaptersOnce(g, { adaptersDir: peerAdapters });
  expect("peer re-pass is a no-op (already have it)", r4.fetched === undefined);

  await g.close();
  console.log("\n🟢 PASS — hub adapter-sync publishes, peers fetch (sha256 verified), passes are idempotent");
} catch (err) {
  console.error("\n🔴 FAIL:", err);
  process.exitCode = 1;
} finally {
  cleanup();
}
