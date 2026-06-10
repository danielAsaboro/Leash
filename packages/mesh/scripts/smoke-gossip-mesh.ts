/**
 * Smoke: GossipMesh — the LEADERLESS signed-gossip store for public cells (spec §1 note / §9 / (B)).
 *
 *   npx tsx packages/mesh/scripts/smoke-gossip-mesh.ts
 *
 * Single-process, OFFLINE (loopback replication piped by hand). THREE devices in one public cell,
 * each on its OWN per-cell-seeded corestore (distinct, private-unlinkable identity). They exchange
 * feed keys (simulating discovery) and replicate pairwise — NO founder, NO root writer.
 *
 * GO when:
 *   (A) IDENTITY   — same (masterSeed, cellId) → same derived seed; different masterSeed → different
 *                    feed key, so each device has a distinct, deterministic, per-cell author identity.
 *   (B) MERGE      — after gossip, ALL three devices converge to the SAME merged message set (the
 *                    union of every feed), each message attributed to its author's feed key.
 *   (C) LEADERLESS — the view is symmetric: no device is privileged, and a late joiner sees the
 *                    whole history while everyone sees the late joiner — without any founder.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import type { Duplex } from "node:stream";
import Corestore from "corestore";
import { GossipMesh, deriveCellSeed } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "logs", "gossip-smoke");
const cleanup = () => rmSync(root, { recursive: true, force: true });

function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}
function pipe(a: unknown, b: unknown): void {
  (a as Duplex).pipe(b as Duplex).pipe(a as Duplex);
}
/** A per-cell-seeded GossipMesh for a device (the seed makes its feed key private-unlinkable). */
async function device(name: string, masterSeed: string, cellId: string): Promise<GossipMesh> {
  const store = new Corestore(join(root, name), { primaryKey: Buffer.from(deriveCellSeed(masterSeed, cellId), "hex"), unsafe: true, allowBackup: true });
  await store.ready();
  return GossipMesh.open({ store });
}
const sig = (ms: { author: string; kind: string; data: unknown }[]) =>
  ms.map((m) => `${m.author.slice(0, 8)}:${m.kind}:${JSON.stringify(m.data)}`).sort().join("|");

try {
  cleanup();
  const CELL = "geocell-demo-abcd"; // a real cell id is a geohash (Phase 3); fixed here

  // ── (A) IDENTITY ────────────────────────────────────────────────────────────────────────────
  expect("deriveCellSeed is deterministic", deriveCellSeed("masterA", CELL) === deriveCellSeed("masterA", CELL));
  expect("different master seeds → different cell seeds (unlinkable)", deriveCellSeed("masterA", CELL) !== deriveCellSeed("masterB", CELL));

  const a = await device("A", "masterA", CELL);
  const b = await device("B", "masterB", CELL);
  expect("each device has a distinct per-cell author identity", a.authorKey !== b.authorKey && /^[0-9a-f]{64}$/.test(a.authorKey));

  // ── posts BEFORE anyone connects (no founder, no ordering authority) ──────────────────────────
  await a.post("presence", { name: "A" });
  await a.post("alert", { kind: "fire", where: "5th & Main" });
  await b.post("presence", { name: "B" });
  await b.post("alert", { kind: "fire-confirm", by: "B" });

  // exchange feed keys (this is what mDNS / a discovery feed will carry) + replicate
  a.addPeerFeed(b.authorKey);
  b.addPeerFeed(a.authorKey);
  pipe(a.replicate(true), b.replicate(false));

  await a.sync();
  await b.sync();

  // ── (B) MERGE ─────────────────────────────────────────────────────────────────────────────────
  const av = await a.all();
  const bv = await b.all();
  expect("A and B converge to the SAME merged view", sig(av) === sig(bv));
  expect("merged view holds every author's messages (4 total)", av.length === 4);
  expect("messages are attributed to their author's feed key", av.some((m) => m.author === a.authorKey && m.kind === "alert") && av.some((m) => m.author === b.authorKey && m.kind === "alert"));

  // ── (C) LEADERLESS — a late joiner C, no founder ────────────────────────────────────────────
  const c = await device("C", "masterC", CELL);
  await c.post("presence", { name: "C" });
  for (const [x, y] of [[a, c], [b, c]] as const) {
    x.addPeerFeed(y.authorKey);
    y.addPeerFeed(x.authorKey);
    pipe(x.replicate(true), y.replicate(false));
  }
  await c.sync();
  await a.sync();
  await b.sync();

  const cv = await c.all();
  expect("late joiner C sees the WHOLE prior history (5 total)", cv.length === 5);
  expect("everyone now sees C's message too (symmetric, no leader)", (await a.all()).some((m) => m.author === c.authorKey) && (await b.all()).some((m) => m.author === c.authorKey));
  expect("all three devices hold the identical merged set", sig(await a.all()) === sig(cv) && sig(await b.all()) === sig(cv));

  await a.close();
  await b.close();
  await c.close();
  console.log("\n🟢 PASS — leaderless signed-gossip: per-cell identity, full merge, symmetric, founder-free");
} catch (err) {
  console.error("\n🔴 FAIL:", err);
  process.exitCode = 1;
} finally {
  cleanup();
}
