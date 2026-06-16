# Mesh-native Task Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ONE data type (**tasks**) replicate across the user's single private mesh — desktop ↔ desktop ↔ phone — with the phone as a real CRDT-running mesh member, as the proving slice for syncing all personal data.

**Architecture:** Tasks become entries in the existing private-mesh Autobase CRDT (`@mycelium/mesh` `MeshGraph`), LWW-by-`updatedAt` with delete tombstones. Desktop/web read+write through the hypha daemon's HTTP API (existing hub-spoke). The phone runs its **own** `MeshHost`/`MeshGraph` inside a `react-native-bare-kit` Bare worklet (proven feasible by the 2026-06-16 spike) and joins the same mesh via blind-pairing; the RN UI talks to the worklet over `BareKit.IPC`. A derived "oldest-active-member" leader is computed (not messaged) from the replicated state.

**Tech Stack:** TypeScript (ESM), `@mycelium/mesh` (Autobase + Hyperbee + Hypercore + Corestore + Hyperswarm), `@mycelium/shared`, `apps/hypha` (Node daemon), `apps/web` (Next.js), `apps/mobile` (Expo RN, JSC engine, `react-native-bare-kit` Bare worklets), `bare-pack` + the `@qvac/sdk` `withMobileBundle` expo plugin. **Tests are standalone `tsx` scripts** asserting via `node:assert` (the repo idiom — see `spike/05-autobase-pairing.ts`; run with `npx tsx <file>`). There is no vitest/jest.

**Spec:** `docs/superpowers/specs/2026-06-16-mesh-task-sync-design.md` (read it first).

---

## File Structure

**Phase 1 — mesh data model (`packages/mesh`, `packages/shared`)**
- Modify `packages/shared/src/index.ts` — add `joinedAt?: number` to `DeviceCapability` (leader seniority).
- Modify `packages/mesh/src/mesh-graph.ts` — add `MeshTask` type, `task`/`task-delete` to the `Entry` union, LWW apply cases, and `MeshGraph` methods `publishTask`/`deleteTask`/`tasks`/`tasksSince`/`leader`.
- Modify `packages/mesh/src/index.ts` — export `MeshTask`.
- Create `packages/mesh/scripts/task-sync.test.ts` — tsx assertion script (loopback convergence + leader derivation).

**Phase 2 — hypha endpoints + leader (`apps/hypha`)**
- Modify `apps/hypha/src/shim.ts` — add `/tasks`, `/tasks/delete`, `/tasks/since`, and `leader` on `/peers`.
- Modify `apps/hypha/src/main.ts` — persist/advertise each mesh's `joinedAt`; expose task ops + `leader()` on the mesh controller; emit `tasks` on the `MeshEventBus`.
- Create `apps/hypha/scripts/task-sync.test.ts` — two in-process hosts over loopback, converge.

**Phase 3 — web (`apps/web`)**
- Create `apps/web/lib/leash/tasks-client.ts` — fetches hypha `/tasks*`.
- Create `apps/web/app/api/leash/hypha/tasks/route.ts` — proxy to hypha.
- Modify the web Tasks panel (`apps/web/components/TasksPanel.tsx`) — read/write via the client + SSE live updates.
- Modify `packages/leash-core/src/tasks-store.ts` — one-time migration import into the mesh (guarded marker).

**Phase 4 — mobile mesh worklet (`apps/mobile`)**
- Create `apps/mobile/worklets/mesh-worklet.mjs` — `MeshHost`/`MeshGraph` in Bare; IPC command set.
- Create `apps/mobile/meshClient.ts` — RN↔worklet bridge (promise-wrapped IPC + `tasks.changed` event).
- Build via the `withMobileBundle` pipeline with addon versions aligned (Bundling note).

**Phase 5 — mobile tasks over the worklet (`apps/mobile`)**
- Modify `apps/mobile/tasks.ts` — back the existing API with the worklet + local-replica cache.
- Modify `apps/mobile/TasksScreen.tsx` — mesh/leader status chip + live updates.
- Modify `apps/mobile/MeshScreen.tsx` (+ `MeshSheet.tsx`) — "join a mesh" via invite.

**Phase 6 — end-to-end verification + sawdust.**

---

## Phase 1 — Mesh data model

### Task 1.1: Add `joinedAt` to DeviceCapability

**Files:**
- Modify: `packages/shared/src/index.ts:223` (the `lastSeen` field of `DeviceCapability`)

- [ ] **Step 1: Add the field** — directly above `lastSeen: string; // ISO timestamp` in `interface DeviceCapability`, add:

```ts
  /**
   * Epoch ms when this device first advertised into `meshId` — its join "seniority", persisted
   * per device per mesh and re-sent on every heartbeat. Drives the oldest-active-member leader
   * (see MeshGraph.leader). Absent on pre-leader caps → treated as "infinitely senior-less"
   * (only counts as leader if no dated cap is live).
   */
  joinedAt?: number;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b packages/shared`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add DeviceCapability.joinedAt for mesh leader seniority"
```

### Task 1.2: MeshTask type + Entry union + export

**Files:**
- Modify: `packages/mesh/src/mesh-graph.ts:29-38` (the `Entry` union) and the exported types near `AdapterMeta`
- Modify: `packages/mesh/src/index.ts`

- [ ] **Step 1: Add the `MeshTask` type** — in `packages/mesh/src/mesh-graph.ts`, just above `type Entry =` (line 29), add:

```ts
/**
 * A task replicated across the private mesh. Superset of the desktop `LeashTask`
 * (packages/leash-core) and the mobile `Task` (apps/mobile/tasks.ts); both map onto it.
 * LWW by `updatedAt`; a delete is a tombstone (`deleted: true`) so it converges too.
 */
export interface MeshTask {
  id: string;
  title: string;
  detail?: string;
  status: "open" | "in_progress" | "done" | "dropped";
  priority: "low" | "normal" | "high";
  tags: string[];
  source: string; // "user" | "assistant" | device origin
  createdAt: number;
  updatedAt: number; // LWW key (epoch ms)
  deleted?: boolean; // tombstone
}
```

- [ ] **Step 2: Extend the `Entry` union** — change lines 37-38 from:

```ts
  | { type: "adapter"; meta: AdapterMeta }
  | { type: "plugin"; meta: MeshPluginMeta };
```

to:

```ts
  | { type: "adapter"; meta: AdapterMeta }
  | { type: "plugin"; meta: MeshPluginMeta }
  | { type: "task"; task: MeshTask }
  | { type: "task-delete"; id: string; ts: number };
```

- [ ] **Step 3: Export `MeshTask`** — in `packages/mesh/src/index.ts`, find the line exporting `MeshGraph`/types from `./mesh-graph` and add `MeshTask` to it (it's a `type` export). If the file re-exports with `export { MeshGraph, ... } from "./mesh-graph.ts"`, add `type MeshTask` to the brace list; if it uses `export *`, no change needed (verify by `grep -n "mesh-graph" packages/mesh/src/index.ts`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b packages/mesh`
Expected: exit 0 (the new `task`/`task-delete` Entry variants are not yet handled in `viewApply`, but TS doesn't force exhaustiveness here — that's Task 1.3).

- [ ] **Step 5: Commit**

```bash
git add packages/mesh/src/mesh-graph.ts packages/mesh/src/index.ts
git commit -m "feat(mesh): add MeshTask type + task/task-delete entries"
```

### Task 1.3: LWW apply for task / task-delete

**Files:**
- Modify: `packages/mesh/src/mesh-graph.ts:260-266` (inside `viewApply`, after the `adapter` and `plugin` cases)

- [ ] **Step 1: Add the apply cases** — inside `viewApply`, immediately before the closing `}` of the `for` loop (after the `plugin` `if` block ends at ~line 266), add:

```ts
    if (value?.type === "task") {
      // LWW by updatedAt, keyed task:<id> (mirrors the unpair LWW pattern above).
      const existing = (await bee.get("task:" + value.task.id)) as { value?: MeshTask } | null;
      if (!existing?.value || value.task.updatedAt >= existing.value.updatedAt) {
        await bee.put("task:" + value.task.id, value.task);
      }
      continue;
    }
    if (value?.type === "task-delete") {
      // Tombstone (deleted:true), LWW by ts: a delete only wins if it's >= the stored updatedAt.
      const existing = (await bee.get("task:" + value.id)) as { value?: MeshTask } | null;
      if (!existing?.value || value.ts >= existing.value.updatedAt) {
        const base = existing?.value ?? {
          id: value.id, title: "", status: "dropped" as const, priority: "normal" as const,
          tags: [], source: "", createdAt: value.ts,
        };
        await bee.put("task:" + value.id, { ...base, id: value.id, deleted: true, updatedAt: value.ts });
      }
      continue;
    }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b packages/mesh`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/mesh/src/mesh-graph.ts
git commit -m "feat(mesh): LWW apply for task + task-delete tombstones"
```

### Task 1.4: MeshGraph task methods

**Files:**
- Modify: `packages/mesh/src/mesh-graph.ts` (after the `capabilities()` method, ~line 461)

- [ ] **Step 1: Add the methods** — after `async capabilities(): Promise<DeviceCapability[]>` (ends ~line 461), add:

```ts
  /** Publish/upsert a task into the mesh (LWW by updatedAt). Requires a writable mesh. */
  async publishTask(task: MeshTask): Promise<void> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot publish a task");
    await this.base.append({ type: "task", task });
  }

  /** Tombstone a task (LWW by ts). Requires a writable mesh. */
  async deleteTask(id: string, ts: number): Promise<void> {
    if (!this.base.writable) throw new Error("mesh not writable on this device — cannot delete a task");
    await this.base.append({ type: "task-delete", id, ts });
  }

  /** Non-deleted tasks, newest first. */
  async tasks(): Promise<MeshTask[]> {
    await this.base.update();
    const out: MeshTask[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "task:", lt: "task;" })) {
      const t = value as MeshTask;
      if (!t.deleted) out.push(t);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Tasks (INCLUDING tombstones) changed since `cursor` (epoch ms) — for delta pulls. */
  async tasksSince(cursor: number): Promise<MeshTask[]> {
    await this.base.update();
    const out: MeshTask[] = [];
    for await (const { value } of this.base.view.createReadStream({ gte: "task:", lt: "task;" })) {
      const t = value as MeshTask;
      if (t.updatedAt > cursor) out.push(t);
    }
    return out;
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b packages/mesh`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/mesh/src/mesh-graph.ts
git commit -m "feat(mesh): publishTask/deleteTask/tasks/tasksSince on MeshGraph"
```

### Task 1.5: Leader derivation

**Files:**
- Modify: `packages/mesh/src/mesh-graph.ts` (after `tasksSince`, beside `capabilities`)

- [ ] **Step 1: Add `leader()`** — after `tasksSince`, add:

```ts
  /**
   * The oldest-active-member leader: the live capability with the smallest `joinedAt`
   * (tiebroken by deviceId). Derived purely from replicated state — no election messages,
   * so it can't flap from network jitter. A member is "live" if its capability `lastSeen`
   * is within `staleMs` (same liveness window as failover.ts). Returns the leader's
   * deviceId, or null if no dated, live capability exists.
   */
  async leader(staleMs = 30_000, now: number = Date.now()): Promise<string | null> {
    const caps = await this.capabilities();
    const live = caps.filter(
      (c) => typeof c.joinedAt === "number" && Number.isFinite(Date.parse(c.lastSeen)) && now - Date.parse(c.lastSeen) <= staleMs,
    );
    if (!live.length) return null;
    live.sort((a, b) => (a.joinedAt! - b.joinedAt!) || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
    return live[0]!.deviceId;
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b packages/mesh`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/mesh/src/mesh-graph.ts
git commit -m "feat(mesh): derive oldest-active-member leader from replicated state"
```

### Task 1.6: Convergence + leader test (tsx script)

**Files:**
- Create: `packages/mesh/scripts/task-sync.test.ts`
- Modify: root `package.json` (add a `test:mesh:tasks` script)

- [ ] **Step 1: Read the reference harness** so the two-graph loopback setup matches the repo idiom.

Run: `sed -n '1,80p' spike/05-autobase-pairing.ts`
Expected: shows how two `MeshGraph`/`MeshHost` instances are created, paired, and replicated over loopback (Hyperswarm or direct `replicate`). Reuse its setup verbatim for graphs A and B.

- [ ] **Step 2: Write the test script** — `packages/mesh/scripts/task-sync.test.ts`:

```ts
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
import { MeshTask } from "../src/index.ts";
// Reuse the EXACT two-graph loopback setup from spike/05-autobase-pairing.ts (Step 1).
// Pseudocode for the harness boundary — replace `makePairedGraphs()` with that setup:
import { makePairedGraphs } from "./_harness.ts"; // extract from spike/05 in Step 1

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
```

- [ ] **Step 3: Extract `_harness.ts`** from `spike/05-autobase-pairing.ts` — create `packages/mesh/scripts/_harness.ts` exporting `makePairedGraphs(): Promise<{ a: MeshGraph; b: MeshGraph; close: () => Promise<void> }>` using two temp `MeshHost`s (or `MeshGraph.build` + a mint/pair) that replicate over loopback, copied from that spike's setup. Use `node:os` `tmpdir()` + `node:crypto` `randomUUID()` for unique store dirs.

- [ ] **Step 4: Add the npm script** — in root `package.json` `scripts`, add:

```json
    "test:mesh:tasks": "tsx packages/mesh/scripts/task-sync.test.ts",
```

- [ ] **Step 5: Run the test — expect FAIL first if any method is wrong, then PASS**

Run: `npm run test:mesh:tasks`
Expected: `✓ task-sync mesh tests passed`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/mesh/scripts/task-sync.test.ts packages/mesh/scripts/_harness.ts package.json
git commit -m "test(mesh): task LWW convergence + tombstone + leader derivation"
```

---

## Phase 2 — hypha endpoints + leader

> Read `apps/hypha/src/shim.ts` top-of-file route table and `main.ts` `meshController` (the object with `foundMesh`/`inviteToMesh`/etc., ~line 559) before starting — you'll mirror those exact patterns.

### Task 2.1: Advertise + persist `joinedAt` per mesh

**Files:**
- Modify: `apps/hypha/src/main.ts` (the per-mesh heartbeat/advertise path + the `MeshRecord` persistence)

- [ ] **Step 1:** When a mesh comes online (`bringMeshOnline`), compute a stable `joinedAt`: read it from the persisted `MeshRecord`; if absent, set `joinedAt = Date.now()` and persist it back to `meshes.json` (mirror the `backfillBootstrapKey` pattern). Include `joinedAt` in the `DeviceCapability` passed to `startHeartbeat`/`advertise` (the heartbeat builds the cap with `lastSeen`; add `joinedAt`).

- [ ] **Step 2: Typecheck** — Run: `npx tsc -b apps/hypha` — Expected: exit 0.

- [ ] **Step 3: Commit** — `git commit -am "feat(hypha): persist + advertise per-mesh joinedAt"`

### Task 2.2: Task ops + leader on the mesh controller

**Files:**
- Modify: `apps/hypha/src/main.ts` (the `meshController` object)

- [ ] **Step 1:** Add controller methods that operate on the **primary** mesh's `MeshGraph` (`host.get(PRIMARY_MESH_ID)` or the existing accessor): `listTasks()` → `graph.tasks()`; `upsertTask(task)` → ensure `updatedAt` (default `Date.now()`) then `graph.publishTask(task)` + emit `MeshEventBus` `{type:"tasks"}`; `deleteTask(id)` → `graph.deleteTask(id, Date.now())` + emit; `tasksSince(cursor)` → `graph.tasksSince(cursor)`; `leader()` → `graph.leader()`. Guard writes by polling `graph.update()` until `graph.writable` (≤6s), mirroring `inviteToMesh`.

- [ ] **Step 2: Typecheck + Commit** — `npx tsc -b apps/hypha`; `git commit -am "feat(hypha): task ops + leader on mesh controller"`

### Task 2.3: HTTP routes on the shim

**Files:**
- Modify: `apps/hypha/src/shim.ts`

- [ ] **Step 1:** Register routes mirroring the existing `/mesh/*` handlers:
  - `GET /tasks` → `meshController.listTasks()`
  - `POST /tasks` (JSON body = a partial `MeshTask`) → `meshController.upsertTask(body)`
  - `POST /tasks/delete` (`{id}`) → `meshController.deleteTask(id)`
  - `GET /tasks/since?cursor=<ms>` → `meshController.tasksSince(Number(cursor)||0)`
  - extend the existing `GET /peers` response to include `leader: await meshController.leader()`.

- [ ] **Step 2: Commit** — `git commit -am "feat(hypha): /tasks routes + leader on /peers"`

### Task 2.4: Two-host loopback integration test

**Files:**
- Create: `apps/hypha/scripts/task-sync.test.ts`; add root `package.json` script `test:hypha:tasks`.

- [ ] **Step 1:** Write a tsx script that boots two hypha mesh controllers over loopback (reuse `packages/mesh/scripts/_harness.ts`), calls `upsertTask` on one, asserts `listTasks` on the other converges, and asserts `leader()` agrees on both. Run: `npm run test:hypha:tasks` → `✓`, exit 0.

- [ ] **Step 2: Commit** — `git add apps/hypha/scripts/task-sync.test.ts package.json && git commit -m "test(hypha): two-host task convergence + leader agreement"`

---

## Phase 3 — web reads/writes via hypha

> Mirror an existing proxy in `apps/web/app/api/leash/hypha/<x>/route.ts` and the client in `apps/web/lib/leash/hypha.ts`.

### Task 3.1: tasks client + proxy route

**Files:**
- Create: `apps/web/lib/leash/tasks-client.ts`, `apps/web/app/api/leash/hypha/tasks/route.ts`

- [ ] **Step 1:** `tasks-client.ts` exports `listTasks()`, `upsertTask(task)`, `deleteTask(id)`, `tasksSince(cursor)` that `fetch` the proxy route (which forwards to `http://127.0.0.1:${HYPHA_PORT}/tasks*`, copying the pattern in the sibling hypha proxy routes). The route forwards GET/POST verbatim.
- [ ] **Step 2: Typecheck + Commit** — `npx tsc -b apps/web`; `git commit -am "feat(web): tasks client + hypha proxy route"`

### Task 3.2: Wire TasksPanel + live SSE

**Files:**
- Modify: `apps/web/components/TasksPanel.tsx`

- [ ] **Step 1:** Replace its local `tasks-store` reads/writes with `tasks-client`. Subscribe to the existing hypha SSE `events` proxy; on a `tasks` event, re-`listTasks()`.
- [ ] **Step 2: Commit** — `git commit -am "feat(web): TasksPanel reads/writes the mesh via hypha + live SSE"`

### Task 3.3: One-time migration of local tasks into the mesh

**Files:**
- Modify: `packages/leash-core/src/tasks-store.ts` (or a hypha bootstrap)

- [ ] **Step 1:** On hypha startup, if `data/.tasks-migrated` is absent and `data/leash-tasks.json` has tasks, `upsertTask` each into the mesh (idempotent — LWW by id), then write the marker. Document that the local JSON becomes a read-through cache/fallback when hypha is down.
- [ ] **Step 2: Commit** — `git commit -am "feat: migrate local tasks into the mesh once (guarded)"`

**Acceptance (Phase 3):** run two desktop hypha+web instances paired into one mesh; create/edit/complete/delete on one, see it on the other within seconds.

---

## Phase 4 — mobile mesh worklet (the proven Bare-CRDT path)

> The spike proved corestore/autobase/hyperbee/rocksdb run in `react-native-bare-kit`. **Honor the Bundling note in the spec:** worklet addon patch versions MUST match `node_modules/react-native-bare-kit/ios/addons/*.xcframework`.

### Task 4.1: The mesh worklet

**Files:**
- Create: `apps/mobile/worklets/mesh-worklet.mjs`

- [ ] **Step 1:** Write a Bare worklet that: reads the writable store dir + an optional `invite` from `Bare.argv`; derives the mesh seed `sha256(deviceSeed + ":mesh")` (passed in as an arg so RN owns the device seed); opens a `MeshHost` on a Corestore under that dir; opens/joins `PRIMARY_MESH_ID` (if an `invite` is provided and not yet a member, `MeshGraph.pair({invite,...})`); joins the swarm; advertises a capability (with `joinedAt`) on a heartbeat. Then handles newline-JSON IPC commands (mirror `forward-worklet.mjs` framing): `{cmd:"tasks.list"}` → reply tasks; `{cmd:"tasks.upsert",task}`; `{cmd:"tasks.delete",id,ts}`; `{cmd:"join",invite}`; `{cmd:"status"}` → `{writable, peers, leader, lastSeen}`. After any view change (poll `update()` on a short timer), emit `{ev:"tasks.changed"}`.

- [ ] **Step 2: Bundle it via the project pipeline** — do NOT hand-roll `bare-pack`. Build through the `withMobileBundle` expo plugin (the path that produces the working SDK worker bundle). Verify the produced `mesh-worklet.bundle.js` references only addon versions that exist in `node_modules/react-native-bare-kit/ios/addons/` (the spike's alignment check):

```bash
cd apps/mobile
node -e 'const fs=require("fs");const dir="node_modules/react-native-bare-kit/ios/addons";const vend=new Set(fs.readdirSync(dir).filter(f=>f.endsWith(".xcframework")).map(f=>f.replace(/\.xcframework$/,"")));const b=fs.readFileSync("worklets/mesh-worklet.bundle.js","utf8");const linked=[...new Set([...b.matchAll(/linked:([a-z0-9@/_-]+\.\d+\.\d+\.\d+)\.framework/g)].map(m=>m[1]))];const bad=linked.filter(l=>!vend.has(l));console.log(bad.length?("MISMATCH: "+bad.join(", ")):"all addon versions aligned")'
```
Expected: `all addon versions aligned`. If `MISMATCH`, apply the spike's alignment pass (`sed` each `NAME.X.Y.Z` → the vendored version) and rebuild.

- [ ] **Step 3: Commit** — `git add apps/mobile/worklets/mesh-worklet.mjs apps/mobile/worklets/mesh-worklet.bundle.js && git commit -m "feat(mobile): mesh-worklet — MeshHost/MeshGraph in Bare"`

### Task 4.2: RN bridge

**Files:**
- Create: `apps/mobile/meshClient.ts`

- [ ] **Step 1:** Mirror `forwardWorklet.ts`: start the worklet once (lazy), promise-wrap each IPC command, expose `joinMesh(invite)`, `listTasks()`, `upsertTask(task)`, `deleteTask(id,ts)`, `meshStatus()`, and an `onTasksChanged(cb)` subscription. Pass the device seed + Documents dir as start args.

- [ ] **Step 2: Typecheck** — `cd apps/mobile && npx tsc --noEmit` → exit 0.

- [ ] **Step 3: On-device bring-up (autonomous loop from the spike)** — temporarily call `meshStatus()` on mount and write the result to a Documents file; build (`expo run:ios`), install + launch via `devicectl`, pull the file. Expected: `writable:true` once joined. Remove the temp probe after. Commit: `git commit -am "feat(mobile): meshClient RN↔worklet bridge"`

---

## Phase 5 — mobile tasks over the worklet

### Task 5.1: Back tasks.ts with the worklet

**Files:**
- Modify: `apps/mobile/tasks.ts`

- [ ] **Step 1:** Keep the public API (`listTasks`/`createTask`/`updateTask`/`deleteTask`/`taskCounts`) but route writes to `meshClient.upsertTask`/`deleteTask` (stamp `updatedAt = Date.now()`), and reads to `meshClient.listTasks()`. Keep the existing JSON file as an instant-render **local replica**: render it first, refresh from the worklet, and rewrite the cache on `onTasksChanged`. Map between the local `Task` shape and `MeshTask` (identical fields except `chatIds`, which the phone doesn't set).
- [ ] **Step 2: Typecheck + Commit** — `npx tsc --noEmit`; `git commit -am "feat(mobile): tasks.ts backed by the mesh worklet + local replica cache"`

### Task 5.2: TasksScreen status chip + live updates

**Files:**
- Modify: `apps/mobile/TasksScreen.tsx`

- [ ] **Step 1:** Add a status chip (member ✓ · N peers · `leader=you/other` · offline) from `meshClient.meshStatus()`; subscribe to `onTasksChanged` to refresh the list live.
- [ ] **Step 2: Commit** — `git commit -am "feat(mobile): Tasks mesh/leader status chip + live updates"`

### Task 5.3: Join-a-mesh UX

**Files:**
- Modify: `apps/mobile/MeshScreen.tsx`, `apps/mobile/MeshSheet.tsx`

- [ ] **Step 1:** Add "Join a mesh": accept an invite (QR scan via the existing `QRScanner`, or pasted sync key) and call `meshClient.joinMesh(invite)`. The invite is minted on a desktop (hypha `/mesh/invite`). Keep the delegated-inference provider-key UI as-is (separate concern).
- [ ] **Step 2: Commit** — `git commit -am "feat(mobile): join the private mesh via invite"`

---

## Phase 6 — end-to-end verification + sawdust

- [ ] **Step 1:** Pair the phone into the mesh with a desktop. Create a task on desktop A → appears on desktop B and the phone. Edit on the phone in airplane mode → reconnect → both desktops reflect it. Delete on a desktop → tombstones on the phone. Confirm the leader chip matches across devices and fails over when the leader quits.
- [ ] **Step 2:** Append a dated `🩹/🧠/📈` entry to `submission/sawdust.md` (the real war-story of this build) and a build-in-public draft per the CLAUDE.md ritual.
- [ ] **Step 3: Final commit** — `git commit -am "docs: sawdust + build-in-public for mesh task sync"`

---

## Notes for the implementer
- **Never `npm install` in the background** (CLAUDE.md). New deps (none expected) install foreground.
- The mobile build/install/launch flow: `expo run:ios` builds + signs but its auto-install fails on Xcode 26.5 `devicectl` JSON — install/launch manually (`xcrun devicectl device install app … && … process launch …`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, hardware UDID from `xcrun xctrace list devices`). See memory `mobile-jsc-not-hermes`.
- Keep the phone's mesh swarm on the **derived** seed (`sha256(seed+":mesh")`) — never the raw SDK `QVAC_HYPERSWARM_SEED` (two swarms under one seed half-open every dial).
- Tests are tsx scripts (`npx tsx <file>`), asserting via `node:assert`, exit non-zero on failure.
