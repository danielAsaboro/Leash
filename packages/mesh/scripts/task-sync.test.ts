/**
 * tsx assertion script (repo idiom — cf. spike/05-autobase-pairing.ts). Verifies:
 *  1. a task published on A converges to B,
 *  2. LWW: the greater updatedAt wins regardless of arrival order,
 *  3. a task-delete tombstones on both,
 *  4. tasksSince(cursor) returns the right delta,
 *  5. leader() = smallest joinedAt among live caps.
 * Run: npx tsx packages/mesh/scripts/task-sync.test.ts   (exit 0 = pass)
 */
import assert from "node:assert";
import type { MeshTask } from "../src/index.ts";
import { makePairedGraphs } from "./_harness.ts";

async function main() {
  const { a, b, close } = await makePairedGraphs(); // both writable, replicating over loopback
  const sync = async () => { await a.update(); await b.update(); await new Promise((r) => setTimeout(r, 200)); await a.update(); await b.update(); };

  // 1. publish on A → converges to B
  const t: MeshTask = { id: "t1", title: "buy milk", status: "open", priority: "normal", tags: [], source: "user", createdAt: 1000, updatedAt: 1000 };
  await a.publishTask(t);
  await sync();
  assert.deepEqual((await b.tasks()).map((x) => x.id), ["t1"], "task did not converge A→B");

  // 2. LWW — older update must NOT overwrite newer
  await b.publishTask({ ...t, title: "buy oat milk", updatedAt: 2000 });
  await a.publishTask({ ...t, title: "STALE", updatedAt: 1500 });
  await sync();
  assert.equal((await a.tasks())[0]!.title, "buy oat milk", "LWW failed: stale update won");
  assert.equal((await b.tasks())[0]!.title, "buy oat milk", "LWW failed on B");

  // 3. delete tombstones everywhere
  await a.deleteTask("t1", 3000);
  await sync();
  assert.equal((await a.tasks()).length, 0, "tombstone not applied on A");
  assert.equal((await b.tasks()).length, 0, "tombstone not applied on B");

  // 4. tasksSince includes the tombstone (updatedAt 3000 > cursor 2500)
  assert.equal((await a.tasksSince(2500)).filter((x) => x.id === "t1" && x.deleted).length, 1, "tasksSince missed the tombstone");

  // 5. leader = smallest joinedAt among live caps
  const now = Date.now();
  await a.advertise({ deviceId: "A", displayName: "A", computeClass: "phone", isProvider: false, joinedAt: 100, lastSeen: new Date(now).toISOString() } as any);
  await b.advertise({ deviceId: "B", displayName: "B", computeClass: "laptop", isProvider: false, joinedAt: 50, lastSeen: new Date(now).toISOString() } as any);
  await sync();
  assert.equal(await a.leader(30_000, now), "B", "leader should be the oldest (smallest joinedAt) live member");
  // stale out B → leadership passes to A
  await b.advertise({ deviceId: "B", displayName: "B", computeClass: "laptop", isProvider: false, joinedAt: 50, lastSeen: new Date(now - 60_000).toISOString() } as any);
  await sync();
  assert.equal(await a.leader(30_000, now), "A", "leadership should fail over to the next-oldest live member");

  await close();
  console.log("✓ task-sync mesh tests passed");
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
