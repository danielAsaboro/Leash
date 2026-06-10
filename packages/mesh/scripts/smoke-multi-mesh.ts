/**
 * Smoke: multi-mesh membership over ONE MeshHost (spec §3, §12).
 *
 *   npx tsx packages/mesh/scripts/smoke-multi-mesh.ts
 *
 * Single-process, OFFLINE (swarm:false; loopback replication piped by hand) — exercises the
 * real MeshHost path: many meshes on one root Corestore (each a namespace) replicating over a
 * single stream, exactly as the shared Hyperswarm's one connection handler would.
 *
 * GO when:
 *   (A) ISOLATION   — two meshes on one host have distinct autobase + writer keys, and a node
 *                     written into M1 never appears in M2's view (namespaces don't bleed).
 *   (B) MIGRATION   — a store founded the OLD single-mesh way, reopened via MeshHost as PRIMARY
 *                     (default namespace), keeps its writer key, autobase key, AND data. This is
 *                     the §3.1 guard: upgrading to multi-mesh does NOT break the live pairing.
 *   (C) REPLICATION — a second host bootstrapped to M1+M2 receives each mesh's node over a SINGLE
 *                     shared root-store stream, with no cross-mesh bleed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import type { Duplex } from "node:stream";
import b4a from "b4a";
import { MeshGraph, MeshHost, PRIMARY_MESH_ID } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "logs", "multi-mesh-smoke");
const dirs = {
  legacy: join(root, "legacy"),
  hostA: join(root, "hostA"),
  hostB: join(root, "hostB"),
};
const cleanup = () => rmSync(root, { recursive: true, force: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}
async function waitFor(label: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) { console.log(`✅ ${label}`); return; }
    await sleep(200);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  cleanup();

  // ── (B) MIGRATION TRAP — found a store the OLD way, reopen as PRIMARY via MeshHost ──────────
  const legacy = await MeshGraph.open({ storeDir: dirs.legacy });
  const legacyWriter = legacy.localWriterKey;
  const legacyAutobase = legacy.autobaseKey;
  await legacy.append({ kind: "note", source: "legacy", text: "pre-upgrade node" });
  await legacy.close();

  const migrated = await MeshHost.open({ rootDir: dirs.legacy, swarm: false });
  const { graph: primary } = await migrated.openMesh({ meshId: PRIMARY_MESH_ID });
  expect("PRIMARY preserves the legacy writer key", primary.localWriterKey === legacyWriter);
  expect("PRIMARY preserves the legacy autobase key", primary.autobaseKey === legacyAutobase);
  await primary.update();
  expect("PRIMARY recovers the legacy node (data survives the upgrade)", (await primary.all()).some((n) => n.source === "legacy"));
  await migrated.close();

  // ── (A) ISOLATION — two meshes on one host ──────────────────────────────────────────────────
  const hostA = await MeshHost.open({ rootDir: dirs.hostA, swarm: false });
  const { graph: g1 } = await hostA.openMesh({ meshId: "A-home" });
  const { graph: g2 } = await hostA.openMesh({ meshId: "A-work" });
  expect("two meshes have distinct autobase keys", g1.autobaseKey !== g2.autobaseKey);
  expect("two meshes have distinct writer keys", g1.localWriterKey !== g2.localWriterKey);

  await g1.append({ kind: "note", source: "A", text: "secret-m1" });
  await g2.append({ kind: "note", source: "A", text: "secret-m2" });
  const v1 = (await g1.all()).map((n) => n.text);
  const v2 = (await g2.all()).map((n) => n.text);
  expect("M1 view has its own node only", v1.includes("secret-m1") && !v1.includes("secret-m2"));
  expect("M2 view has its own node only", v2.includes("secret-m2") && !v2.includes("secret-m1"));

  // ── (C) REPLICATION — a second host reads BOTH meshes over ONE shared stream ────────────────
  const hostB = await MeshHost.open({ rootDir: dirs.hostB, swarm: false });
  const { graph: b1 } = await hostB.openMesh({ meshId: "B-1", bootstrapKey: b4a.from(g1.autobaseKey, "hex") });
  const { graph: b2 } = await hostB.openMesh({ meshId: "B-2", bootstrapKey: b4a.from(g2.autobaseKey, "hex") });

  // One loopback pipe over the ROOT stores carries every namespace (what the shared swarm does).
  const sa = hostA.replicate(true) as Duplex;
  const sb = hostB.replicate(false) as Duplex;
  sa.pipe(sb).pipe(sa);

  await waitFor("B/M1 replicates A/M1's node over the shared stream", async () => { await b1.update(); return (await b1.all()).some((n) => n.text === "secret-m1"); });
  await waitFor("B/M2 replicates A/M2's node over the shared stream", async () => { await b2.update(); return (await b2.all()).some((n) => n.text === "secret-m2"); });
  const bv1 = (await b1.all()).map((n) => n.text);
  const bv2 = (await b2.all()).map((n) => n.text);
  expect("B/M1 has NO M2 bleed (per-namespace replication)", !bv1.includes("secret-m2"));
  expect("B/M2 has NO M1 bleed (per-namespace replication)", !bv2.includes("secret-m1"));

  await hostA.close();
  await hostB.close();
  console.log("\n🟢 PASS — multi-mesh isolation, migration trap, and per-mesh replication all hold");
} catch (err) {
  console.error("\n🔴 FAIL:", err);
  process.exitCode = 1;
} finally {
  cleanup();
}
