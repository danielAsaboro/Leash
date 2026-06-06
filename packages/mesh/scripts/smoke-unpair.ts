/**
 * Smoke: unpair-record LWW ordering (the mutual-disconnect CRDT).
 *
 *   npx tsx packages/mesh/scripts/smoke-unpair.ts
 *
 * Single-process, offline (no swarm) — exercises the REAL viewApply path by appending
 * unpair entries to a founded MeshGraph and reading them back via unpairs().
 *
 * GO when all three ordering invariants hold:
 *   1. unpair (active:true) then a LATER retraction (active:false) → edge not unpaired.
 *   2. a STALE active:true replicating in after the retraction → still not unpaired (LWW).
 *   3. the edge key is order-independent — (B,A) updates the same record as (A,B).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { MeshGraph, unpairKey, type UnpairRecord } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "logs", "unpair-smoke-store");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const A = "aa".repeat(32);
const B = "bb".repeat(32);

function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}

try {
  rmSync(dir, { recursive: true, force: true });
  const g = await MeshGraph.open({ storeDir: dir });
  // Raw append (bypasses unpair()'s own ts stamp) — simulates a record from another writer
  // replicating in with an arbitrary timestamp, exactly what LWW must order correctly.
  const raw = (e: { type: "unpair"; a: string; b: string; active: boolean; ts: string }) =>
    (g as unknown as { base: { append(e: unknown): Promise<void> } }).base.append(e);
  const edge = async (): Promise<UnpairRecord | undefined> =>
    (await g.unpairs()).find((r) => unpairKey(r.a, r.b) === unpairKey(A, B));

  // 1. disconnect, then a later re-pair retraction → the retraction wins.
  await g.unpair(A, B, true);
  await sleep(5); // ensure a strictly-later ISO ts
  await g.unpair(A, B, false);
  let rec = await edge();
  expect("later retraction beats earlier unpair", rec !== undefined && rec.active === false);

  // 2. a stale active:true arriving AFTER the retraction → ignored (LWW by ts).
  await raw({ type: "unpair", a: A, b: B, active: true, ts: "2020-01-01T00:00:00.000Z" });
  await g.update();
  rec = await edge();
  expect("stale unpair can't override a newer retraction", rec !== undefined && rec.active === false);

  // 3. order-independent edge key: (B,A) updates the same record as (A,B).
  await sleep(5);
  await g.unpair(B, A, true);
  rec = await edge();
  expect("(B,A) targets the same edge as (A,B)", rec !== undefined && rec.active === true);
  expect("exactly one record per edge", (await g.unpairs()).filter((r) => unpairKey(r.a, r.b) === unpairKey(A, B)).length === 1);

  console.log("\n✅ UNPAIR SMOKE GO");
  await g.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  console.error("❌ unpair smoke failed:", error);
  process.exit(1);
}
