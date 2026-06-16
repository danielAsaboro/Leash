# Mesh-native task sync — vertical slice (desktop · web · mobile)

**Date:** 2026-06-16
**Status:** approved design (revised post-spike), ready for implementation plan
**Scope:** ONE data type (**tasks**) made mesh-replicated end-to-end across all three
clients, as the proving vertical slice for the broader "your data syncs across your
private mesh" goal.

> **Architecture decision (proven by spike, 2026-06-16):** the phone is a **first-class
> private-mesh member that runs the CRDT natively** — not a thin spoke. A throwaway Bare
> worklet ran the full stack on a physical iPhone (Release build) end to end:
> `new Corestore` (RocksDB-backed, iOS sandbox) → `store.ready()` → `new Autobase` →
> `base.ready()` (`writable=true`) → `append` → `update` → read back through the Hyperbee
> view (`got={"k":"hello","v":"world"}`). `corestore`/`autobase`/`hyperbee`/`hypercore`/
> `rocksdb-native` all load and run in `react-native-bare-kit`'s Bare runtime on iOS.
> The only obstacle was a bundling detail (native-addon patch versions in the worklet
> bundle must match the vendored `ios/addons/*.xcframework` versions); see "Bundling note".
> This **supersedes** the earlier "phone syncs to a pinned hub, no CRDT on the phone" plan.

## Context & problem

The user wants their personal data — tasks, notifications, memories, notes — to sync
across their **private device mesh**, so any device shows the same state ("check
everything from any device"). Today none of that is true:

- On **desktop/web**, `tasks` / `memories` / `notifications` / `notes` are local JSON
  files (`data/leash-*.json`, read directly by the web server via `@mycelium/leash-core`).
  They do **not** replicate — even between two paired desktops. Only the private mesh's
  context-graph **nodes**, **capabilities**, **receipts**, **adapters**, and **plugins**
  ride the Autobase CRDT today.
- On **mobile**, the stores added in the dashboard-parity work
  (`apps/mobile/{tasks,memories,notes,notifications}.ts`) are local `expo-file-system`
  JSON, and the phone touches the mesh only for **delegated inference** (a
  `providerPublicKey` over the QVAC SDK's Hyperswarm). It is not a mesh member.

So "sync everything" is two pieces of work: (A) make the desktop/web app-data mesh-native
(it isn't today), and (B) make the phone a real mesh member that holds the same replicated
data. (A) is the prerequisite — there must be a mesh-native task type for any device,
phone included, to replicate.

This slice proves the entire pipe with **tasks** before fanning out to the other types.

## Confirmed constraints (the rules this design obeys)

1. **All data sync/sharing is private-mesh ONLY.** Tasks (this slice) and later
   memories/notes/notifications replicate over the **private mesh** exclusively. The
   **public mesh shares compute only — never personal data.** This is already a
   *structural* guarantee, not a runtime check: public cells (`GossipMesh`/`PublicMesh`)
   carry no app-data entries and cannot widen the provider firewall, so personal data
   physically cannot ride them. This design adds task entries to the **private**
   `MeshGraph` only.
2. **One private mesh for now.** The design targets the single primary mesh
   (`PRIMARY_MESH_ID = "primary"`). Multiple private meshes (and choosing which mesh a
   given task belongs to) are explicitly out of scope; everything assumes the one mesh
   the user's devices are paired into.

## Existing architecture we build on (do not reinvent)

- **Private mesh CRDT** — `packages/mesh/src/mesh-graph.ts` (`MeshGraph`): Autobase
  (multi-writer) + Hyperbee view, idempotent apply. Entry union currently includes
  `node | add-writer | remove-writer | capability | forget-capability | unpair |
  receipt | adapter | plugin`. LWW-by-key is the established pattern (capabilities are
  LWW per `deviceId`; `forget-capability` is a tombstone).
- **Mesh host** — `packages/mesh/src/mesh-host.ts` (`MeshHost`, `PRIMARY_MESH_ID`):
  one root Corestore + one shared Hyperswarm for N private meshes; `"primary"` is the
  anchor mesh.
- **Process topology** — on desktop the **hypha daemon** (`apps/hypha`, localhost
  `:11437`) owns `MeshHost`, the swarm, and the economy; web (`:6801`) and the Electron
  desktop drive it over HTTP (`apps/web/app/api/leash/hypha/*` → `apps/hypha/src/shim.ts`).
  The browser can't run mesh libs, so it calls hypha. **The phone is different:** it
  *can* run the mesh libs (in Bare), so it hosts its **own** `MeshHost`/`MeshGraph` inside
  a Bare worklet and joins the mesh directly — the phone is the analogue of the hypha
  daemon, not of the browser.
- **Hyperswarm in Bare on the phone, already shipping** — `apps/mobile/worklets/forward-worklet.mjs`
  runs Hyperswarm inside `react-native-bare-kit` for mesh vision. The spike extended this
  to the full CRDT (corestore/autobase/hyperbee/rocksdb), proven on-device. So mesh
  membership + replication from the phone is feasible with the existing toolchain.
- **Blind-pairing** — `MeshGraph.mintInvite()` / `MeshGraph.pair({invite,…})` (built on the
  `blind-pairing` module over Hyperswarm) is how a device joins a mesh and is admitted as a
  writer (`add-writer` entry). The phone joins the same way (replacing the test-only
  `providerKey` pin in `apps/mobile/mesh.ts`).
- **Live dashboard updates** — `apps/hypha/src/mesh-events.ts` (`MeshEventBus`) already
  feeds the desktop dashboard via SSE; task changes emit on it.

## Goals

1. Two paired **desktops** see the same tasks, live (create/edit/complete/delete).
2. The **phone**, as a real mesh member, holds the same tasks; edits made on it (incl.
   offline) replicate to both desktops, and theirs replicate to it. Deletes propagate as
   tombstones.
3. No fabricated data; offline-first preserved on the phone (it owns a local CRDT replica).
4. The mesh-membership + leader + replication foundation, and the LWW task model, are a
   **template** the other three data types reuse later with minimal new design.

## Non-goals (this slice)

- memories / notes / notifications (next slices, same pattern).
- Public mesh changes (untouched).
- A **new** pairing mechanism — reuse the existing `MeshGraph` blind-pairing invite/join.
  (The phone does start joining the mesh as a writer, replacing the test-only
  `providerKey` inference pin; that's wiring an existing flow, not inventing one.)
- Merge UI / interactive conflict resolution (LWW is the policy).
- **Multiple private meshes.** Per the confirmed constraint, everything targets the
  single primary mesh; per-mesh task ownership / mesh selection is out of scope.
- **Any data on the public mesh.** The public mesh stays compute-only; this design
  never writes app-data to it.

## Conflict model (the reusable foundation)

Per-task **last-writer-wins by `updatedAt`**, keyed by task `id`. A delete is a
**tombstone** (`deleted: true`, also LWW by `ts`). The id set is grow-only; tombstones
are retained. This mirrors the existing capability-LWW + `forget-capability` tombstone
semantics, is CRDT-safe (commutative/idempotent), and needs no coordinator. It is
sufficient for tasks and is the exact policy memories/notes/notifications will reuse.

Clock note: `updatedAt` is wall-clock ms from whichever device made the edit. Skewed
clocks can mis-order near-simultaneous edits to the *same* task — acceptable for this
data (rare; last edit wins). Documented, not solved, in this slice.

## Data model

New canonical mesh task type (in `packages/shared` or alongside `mesh-graph.ts`):

```ts
type MeshTask = {
  id: string;
  title: string;
  detail?: string;
  status: "open" | "in_progress" | "done" | "dropped";
  priority: "low" | "normal" | "high";
  tags: string[];
  source: string;          // "user" | "assistant" | device-origin
  createdAt: number;
  updatedAt: number;       // LWW key
  deleted?: boolean;       // tombstone
};
```

New Autobase entries (extend the union in `mesh-graph.ts`):

```ts
| { type: "task"; task: MeshTask }
| { type: "task-delete"; id: string; ts: number }
```

Apply logic (idempotent, LWW): keep the task with the greatest `updatedAt` per `id` in
the Hyperbee under key `task/<id>`; a `task-delete` with `ts ≥ stored.updatedAt` sets a
tombstone. `tasks()` returns non-deleted, newest-first.

This is intentionally a superset of both the desktop `LeashTask`
(`packages/leash-core/src/tasks-store.ts`) and the mobile `Task`
(`apps/mobile/tasks.ts`); both map onto it (desktop's `chatIds` is dropped from the
synced shape for this slice — it can be added later without breaking LWW).

## Part A — desktop/web: tasks become mesh-native

**A1. `packages/mesh`** — add the two entry types + apply logic; add `MeshGraph`
methods `publishTask(task)`, `deleteTask(id, ts)`, `tasks(): MeshTask[]`,
`tasksSince(cursorTs): MeshTask[]` (returns tasks + tombstones with `updatedAt`/`ts`
> cursor, for delta pulls). Export `MeshTask` from `packages/mesh/src/index.ts`.

**A2. `apps/hypha`** — on the localhost shim (`shim.ts` + a `task-router`):
- `GET  /tasks` → `graph.tasks()` for the primary mesh.
- `POST /tasks` → upsert (`publishTask`); stamps `updatedAt = now` if absent.
- `POST /tasks/delete` → `deleteTask(id, now)`.
- `GET  /tasks/since?cursor=<ms>` → `tasksSince(cursor)` (delta for the phone).
- Emit a `tasks` event on `MeshEventBus` after any write (dashboard live-update).
- Writes require the mesh to be **writable** (poll `update()` like `inviteToMesh` does).

**A3. `apps/web`** — a `lib/leash/tasks-client.ts` that proxies to hypha (mirroring the
`/api/leash/hypha/*` proxies); add `app/api/leash/hypha/tasks/route.ts`. The web
`TasksPanel` reads/writes through this client instead of the local file. Subscribe to
the hypha SSE `events` stream (already proxied) for live updates.

**A4. Migration** — on first run after upgrade, import existing `data/leash-tasks.json`
into the mesh (publish each task once, guarded by a `tasks-migrated` marker), then treat
the mesh as source of truth. The local JSON remains a read-through cache/fallback when
hypha is unreachable (degraded, read-only).

*Acceptance for Part A:* two desktops paired into one mesh, create/edit/complete/delete
on one, observe on the other within seconds.

## Part B — mobile: the phone as a real mesh member

The phone runs the same `@mycelium/mesh` `MeshHost`/`MeshGraph` the desktop does, but
inside a Bare worklet, and joins the single private mesh as a writer. The React Native UI
talks to that worklet over `BareKit.IPC` (the `forward-worklet` pattern), not over HTTP.

**B1. Mesh worklet** — `apps/mobile/worklets/mesh-worklet.mjs`: boots a `MeshHost` on a
Corestore under the app's Documents dir, opens/joins the primary mesh, joins the swarm,
and exposes an IPC command set to RN:
- `join { invite }` → `MeshGraph.pair(...)` (first join; persists the bootstrapKey).
- `tasks.list` → current tasks; `tasks.upsert { task }` / `tasks.delete { id, ts }` →
  `publishTask` / `deleteTask`.
- `tasks.changed` (push) → emitted whenever the replicated view updates, so the UI is live.
- `status` → `{ writable, peers, leader, lastSeen }` for the UI + leader display.
Identity: the worklet derives its mesh seed from the device seed per CLAUDE.md
(`sha256(seed + ":mesh")`), distinct from the QVAC SDK worker's `QVAC_HYPERSWARM_SEED`, so
the two Hyperswarms never collide. The phone's writer key is its `MeshGraph.localWriterKey`.

**B2. RN bridge** — `apps/mobile/meshClient.ts` (mirrors `forwardWorklet.ts`): starts the
worklet once, wraps the IPC command set in promises, and exposes an event for `tasks.changed`.

**B3. tasks.ts becomes a thin view over the worklet** — `apps/mobile/tasks.ts` keeps its
current API (`listTasks`/`createTask`/`updateTask`/`deleteTask`/`taskCounts`) but backs it
with the mesh worklet: writes go to `tasks.upsert`/`tasks.delete`; reads come from
`tasks.list`; a cached snapshot (the existing JSON file) is the **offline replica** the UI
renders instantly and when the worklet is still booting. The CRDT in the worklet is the
source of truth; the JSON file is a fast local cache refreshed on `tasks.changed`.

**B4. Pairing UX** — the existing Mesh screen gains "join a mesh": scan/enter an invite
minted by a desktop (`MeshGraph.mintInvite()` via hypha's `/mesh/invite`), passed to the
worklet's `join`. This replaces the `providerKey` inference-only pin. Delegated inference
keeps working (unchanged) — it's a separate concern from membership.

**B5. UI** — `TasksScreen` shows a mesh-status chip (member ✓ · N peers · leader=you/other ·
offline) sourced from `status`. Tasks render from the local replica and update live on
`tasks.changed`.

*Acceptance for Part B:* the phone joins the mesh via an invite; a desktop-created task
appears on it; an edit on the phone (incl. offline, then reconnect) appears on both
desktops; a delete tombstones everywhere.

## Leader election (oldest active member) — designed here

The user's model: **the leader is the oldest member that is currently active; if the
leader goes offline, leadership passes to the next-oldest active member.** Autobase data
sync is leaderless (any writer appends; the view linearizes), so the leader is **not**
needed for task convergence — it's a *coordination* role for things that want a single
owner (e.g. who runs the proactive heartbeat loop, who is the canonical rendezvous, who
performs one-shot mesh chores). Designing it now so the model is consistent across clients.

- **Seniority key** = the timestamp of a device's `add-writer` entry in the Autobase
  (its join order — already in the replicated log), tiebroken by writer key. This is a
  deterministic, replicated total order every member computes identically.
- **Liveness** = the existing capability heartbeat: a member is "active" if its
  `capability.lastSeen` is within the staleness window (reuse `failover.ts` `liveProviders`
  semantics / `staleMs`). Each device already re-advertises on a timer.
- **Leader** = the most-senior member whose capability is live. Pure function of the
  replicated state (`add-writer` order + live capabilities); every device derives the same
  leader with no election messages. When the leader's heartbeat goes stale, the
  next-senior live member becomes leader automatically on the next evaluation.
- **Exposed** as `MeshGraph.leader()` (in `packages/mesh`), surfaced by hypha (`/peers`
  gains `leader`) and the phone worklet (`status.leader`), and shown in the UI.
- **Scope guard:** this slice only *computes + displays* the leader and uses it for the
  rendezvous/"is it me" check. Moving the heartbeat loop to "leader-only" is a follow-on
  (it touches the proactivity daemon), noted but not built here.

## Identity / transport / security

- **Membership** = the phone is a writer in the single primary mesh via blind-pairing; its
  writer key is `MeshGraph.localWriterKey` (distinct per mesh, derived from the device seed).
- **Transport** = Hyperswarm (Noise-encrypted) replicating the Corestore between members —
  the same mechanism desktops already use. The phone's mesh swarm uses a derived seed
  (`sha256(seed + ":mesh")`), never the raw SDK seed (CLAUDE.md rule: no two swarms under
  one seed).
- **Encryption** = Hyperswarm Noise in transit; Corestore at rest is unencrypted on disk
  (unchanged from desktop today; acceptable for a single-user trusted mesh).
- **Authorization** = mesh writer admission (`add-writer`, gated by the inviter). A device
  that isn't paired isn't a writer and sees nothing.

## Testing / verification

- **Unit (`packages/mesh`):** LWW apply — out-of-order task updates converge to the
  greatest `updatedAt`; `task-delete` tombstones; `tasksSince(cursor)` returns the right
  delta. Reuse the spike harness style in `spike/05-autobase-pairing.ts` (two in-process
  graphs, replicate over loopback, assert convergence).
- **Integration (hypha):** two hypha instances paired over loopback; `POST /tasks` on
  one → `GET /tasks` on the other converges; SSE emits.
- **Mobile:** `tsc --noEmit` + `expo export -p ios` bundle; on-device — join via invite,
  see a desktop task, edit offline (airplane mode), reconnect, confirm convergence +
  tombstone on both desktops. (Verification harness: the autonomous build→install→launch→
  pull-progress-file loop proven during the spike works for the worklet too.)
- **Regression:** desktop chat/cron/daemons that read tasks still work (web reads via
  hypha; local-file fallback covers hypha-down); mobile delegated inference + mesh vision
  unchanged (the mesh worklet is additive, on a derived seed/separate swarm).

## Bundling note (the spike's lesson — must-honor)

The mesh worklet bundle must be built so every **native-addon patch version** in the
bundle matches the vendored `node_modules/react-native-bare-kit/ios/addons/*.xcframework`
versions (and the manifest `qvac/addons.manifest.json` must allowlist them — it already
lists `rocksdb-native`, `sodium-native`, `simdle-native`, `quickbit-native`,
`fs-native-extensions`, `udx-native`, `rabin-native`). A hand-rolled `bare-pack --linked`
emitted *older* patch versions (e.g. `rocksdb-native.3.15.1` vs the linked `3.15.2`),
causing `ADDON_NOT_FOUND` at worklet load. Build the worklet through the project's
`withMobileBundle` pipeline (the path that produces the working SDK worker bundle, which
references consistent versions), or apply a version-alignment pass against the vendored
frameworks. This is a build-config task, not a code one, but it's load-bearing.

## Risks & mitigations

- **Web reads now depend on hypha being up.** Mitigation: local-file read-through
  fallback (degraded read-only) when hypha is unreachable; writes queue/fail visibly.
- **Mesh worklet is a 2nd Bare worklet + 2nd Hyperswarm alongside the SDK worker.**
  Mitigation: derived seed (`sha256(seed+":mesh")`) so swarms never collide (CLAUDE.md
  rule); the forward-worklet already proves a 2nd swarm coexists; battery — replication is
  only while the app is foregrounded (iOS background limits), acceptable and matches user
  expectation of a phone.
- **Worklet addon version skew → `ADDON_NOT_FOUND`.** Mitigation: the Bundling note —
  align bundle addon versions to the vendored xcframeworks via `withMobileBundle`.
- **Clock skew mis-orders same-task edits.** Accepted (documented); revisit with a logical
  clock if it bites.
- **Leader flapping near the staleness boundary.** Mitigation: leader is derived, not
  messaged (no election traffic to flap); use the same `staleMs` hysteresis as `failover.ts`.
- **Migration double-import.** Mitigation: idempotent (LWW by id) + a `tasks-migrated` marker.

## Implementation phasing (for the plan)

1. **mesh data model** — `task` / `task-delete` entry types + LWW apply + `MeshGraph`
   methods (`publishTask`/`deleteTask`/`tasks`/`tasksSince`) + `leader()` + unit tests
   (loopback convergence, leader derivation).
2. **hypha task endpoints + leader** — shim `/tasks*` routes, `/peers` gains `leader`,
   `MeshEventBus` emit; integration test (two hypha over loopback converge).
3. **web tasks-client** — proxy route + `TasksPanel` reads/writes via hypha + SSE live +
   migration of `data/leash-tasks.json`; verify two-desktop sync.
4. **mobile mesh worklet** — `mesh-worklet.mjs` (MeshHost/MeshGraph in Bare) + `meshClient.ts`
   bridge, built through `withMobileBundle` with addon versions aligned; bring-up: join via
   invite, `status` reports `writable=true`.
5. **mobile tasks over the worklet** — back `tasks.ts` with the worklet + local-replica
   cache + `tasks.changed` live updates + mesh/leader status chip; Mesh-screen join UX.
6. **end-to-end verify** — desktop↔desktop↔phone, incl. offline + delete + leader display;
   sawdust entry.

Each phase: `tsc`/build sanity, then the phase's acceptance check. Phase 4 uses the
autonomous on-device verification loop (build→install→launch→pull progress) proven in the spike.
