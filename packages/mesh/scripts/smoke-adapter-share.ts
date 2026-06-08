/**
 * Smoke: P2P adapter distribution (the Layer-4 model-sharing pointer + sibling feed).
 *
 *   npx tsx packages/mesh/scripts/smoke-adapter-share.ts
 *
 * Single-process, OFFLINE (no swarm) — exercises the REAL publish/fetch path on one
 * founded MeshGraph: chunk a gguf-sized blob onto the sibling `adapter-feed` Hypercore
 * (block 0 = manifest), ride a TINY pointer on the Autobase CRDT, read it back,
 * reassemble, and verify sha256. Proves the hard constraint holds (bytes on the feed,
 * only a pointer on the graph) and that corruption is caught.
 *
 * GO when: round-trip bytes are byte-identical (sha256 match), the pointer is LWW
 * (newest version wins), and corrupt/truncated transfers are REJECTED.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { MeshGraph, verifyAdapterBytes } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = join(here, "..", "logs", "adapter-share-smoke-store");
const srcDir = join(here, "..", "logs", "adapter-share-smoke-src");
const destDir = join(here, "..", "logs", "adapter-share-smoke-dest");

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}

const cleanup = () => {
  for (const d of [storeDir, srcDir, destDir]) rmSync(d, { recursive: true, force: true });
};

try {
  cleanup();
  mkdirSync(srcDir, { recursive: true });

  // A realistic adapter-sized blob spanning several 256 KiB chunks.
  const blob = randomBytes(700 * 1024);
  const ggufPath = join(srcDir, "adapter.gguf");
  writeFileSync(ggufPath, blob);
  const srcSha = sha(blob);

  const g = await MeshGraph.open({ storeDir, swarm: false });

  // ── publish v1 ──
  const meta1 = await g.publishAdapter({ ggufPath, version: "20260608-000001", baseModel: "QWEN3_4B_INST_Q4_K_M", evalDelta: 0.12 });
  expect("publish records the source sha256", meta1.sha256 === srcSha);
  expect("publish chunked into 1 manifest + N gguf blocks", meta1.blockCount === 1 + Math.ceil(blob.length / meta1.chunkSize));
  expect("pointer carries the feed key + size", meta1.feedKey.length === 64 && meta1.sizeBytes === blob.length);

  // ── pointer in the CRDT ──
  const latest = await g.latestAdapter();
  expect("latestAdapter returns the published pointer", latest?.version === "20260608-000001");

  // ── fetch round-trip (same store, offline) ──
  const fetched = await g.fetchLatestAdapter({ destDir, timeoutMs: 5000 });
  if (!fetched) throw new Error("FAILED: fetchLatestAdapter returned null");
  expect("round-trip bytes are byte-identical", sha(readFileSync(fetched.ggufPath)) === srcSha);
  expect("manifest.json was written alongside", readFileSync(fetched.manifestPath, "utf-8").includes("20260608-000001"));

  // ── LWW: a newer version wins adapter:latest ──
  const blob2 = randomBytes(120 * 1024);
  const ggufPath2 = join(srcDir, "adapter2.gguf");
  writeFileSync(ggufPath2, blob2);
  const meta2 = await g.publishAdapter({ ggufPath: ggufPath2, version: "20260608-000002", baseModel: "QWEN3_4B_INST_Q4_K_M", evalDelta: 0.05 });
  expect("second publish appends after the first (startBlock advanced)", meta2.startBlock === meta1.blockCount);
  expect("LWW: newest version wins adapter:latest", (await g.latestAdapter())?.version === "20260608-000002");
  const fetched2 = await g.fetchLatestAdapter({ destDir, timeoutMs: 5000 });
  if (!fetched2) throw new Error("FAILED: fetchLatestAdapter (v2) returned null");
  expect("fetch of newest matches its bytes", sha(readFileSync(fetched2.ggufPath)) === sha(blob2));

  // ── NEGATIVE: corruption + truncation are rejected ──
  const corrupted = Buffer.from(blob2);
  corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
  let corruptThrew = false;
  try { verifyAdapterBytes(corrupted, meta2); } catch { corruptThrew = true; }
  expect("corrupt bytes are REJECTED (sha256 mismatch)", corruptThrew);

  let truncThrew = false;
  try { verifyAdapterBytes(blob2.subarray(0, blob2.length - 16), meta2); } catch { truncThrew = true; }
  expect("truncated bytes are REJECTED (size mismatch)", truncThrew);

  await g.close();
  console.log("\n🟢 PASS — adapter publish/fetch round-trips, LWW holds, corruption rejected");
} catch (err) {
  console.error("\n🔴 FAIL:", err);
  process.exitCode = 1;
} finally {
  cleanup();
}
