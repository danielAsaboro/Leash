/**
 * tsx assertion script (repo idiom) for the HYPHA task layer over loopback. Reuses the mesh
 * package's two-writable-graphs harness and drives the SAME code the hypha mesh controller runs
 * (`normalizeTask` → `graph.publishTask`/`deleteTask`, `graph.leader()`), proving:
 *   1. a task upserted on host A (with hypha's server-stamped defaults) converges to host B,
 *   2. a delete tombstones on both,
 *   3. leader() AGREES on both hosts (the derived oldest-active-member is global, not per-device).
 * Run: npx tsx apps/hypha/scripts/task-sync.test.ts   (exit 0 = pass)
 */
import assert from "node:assert";
import { makePairedGraphs } from "../../../packages/mesh/scripts/_harness.ts";
import { normalizeTask } from "../src/tasks.ts";

async function main() {
  const { a, b, close } = await makePairedGraphs();
  const sync = async () => { await a.update(); await b.update(); await new Promise((r) => setTimeout(r, 200)); await a.update(); await b.update(); };

  // 1. upsert on A via the hypha normalization (a PARTIAL body, server fills defaults) → converges to B
  await a.publishTask(normalizeTask({ id: "h1", title: "hypha task", updatedAt: 1000 }, 1000));
  await sync();
  const onB = await b.tasks();
  assert.deepEqual(onB.map((t) => t.id), ["h1"], "hypha task did not converge A→B");
  assert.equal(onB[0]!.status, "open", "normalizeTask default status missing");
  assert.equal(onB[0]!.source, "user", "normalizeTask default source missing");

  // 2. delete tombstones on both
  await b.deleteTask("h1", 2000);
  await sync();
  assert.equal((await a.tasks()).length, 0, "tombstone not applied on A");
  assert.equal((await b.tasks()).length, 0, "tombstone not applied on B");

  // 3. leader() agrees on both hosts (oldest joinedAt among live caps)
  const now = Date.now();
  await a.advertise({ deviceId: "hostA", displayName: "A", computeClass: "laptop", isProvider: false, joinedAt: 200, lastSeen: new Date(now).toISOString() } as any);
  await b.advertise({ deviceId: "hostB", displayName: "B", computeClass: "laptop", isProvider: false, joinedAt: 100, lastSeen: new Date(now).toISOString() } as any);
  await sync();
  const la = await a.leader(30_000, now);
  const lb = await b.leader(30_000, now);
  assert.equal(la, "hostB", "leader should be the oldest (smallest joinedAt) live member");
  assert.equal(la, lb, "leader() must AGREE across both hosts (derived from shared replicated state)");

  await close();
  console.log("✓ hypha task-sync tests passed");
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
