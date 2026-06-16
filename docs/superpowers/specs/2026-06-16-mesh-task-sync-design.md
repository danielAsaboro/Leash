# Mesh-native task sync — vertical slice (desktop · web · mobile)

**Date:** 2026-06-16
**Status:** approved design, ready for implementation plan
**Scope:** ONE data type (**tasks**) made mesh-replicated end-to-end across all three
clients, as the proving vertical slice for the broader "your data syncs across your
private mesh" goal.

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

So "sync everything" is two pieces of work, and the desktop piece is the prerequisite:
the phone must have a mesh-backed source of truth to sync against.

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
- **Hub topology** — the **hypha daemon** (`apps/hypha`, localhost `:11437`) owns
  `MeshHost`, the swarm, and the economy. **Web (`:6801`) and the Electron desktop are
  already spokes** that drive the mesh through hypha's HTTP API
  (`apps/web/app/api/leash/hypha/*` → `apps/hypha/src/shim.ts`). The browser never runs
  mesh libs; it calls hypha. **Mobile becomes another spoke of the same kind.**
- **Mobile↔hub P2P RPC, proven both ends** — `apps/hypha/src/forward-control.ts`
  (`ForwardControlServer`) runs its own Hyperswarm, joins **per-pair topics**
  (`topicForPair(providerPublicKey, consumerPublicKey)` = `sha256("hypha-forward-v1:"…)`),
  accepts connections **only from allow-listed consumers**, and carries OpenAI-style
  request/response over one long-lived Noise-encrypted, multiplexed connection. The
  phone side is `apps/mobile/worklets/forward-worklet.mjs` (Hyperswarm inside the
  react-native-bare-kit Bare worker). Task sync adds **verbs** to this transport family;
  it invents no new transport and runs **no CRDT on the phone**.
- **Live dashboard updates** — `apps/hypha/src/mesh-events.ts` (`MeshEventBus`) already
  feeds the dashboard via SSE; task changes emit on it.

## Goals

1. Two paired **desktops** see the same tasks, live (create/edit/complete/delete).
2. The paired **phone** pulls those tasks, edits them (incl. offline), and syncs back;
   both desktops reflect the change. Deletes propagate as tombstones.
3. No fabricated data; offline-first preserved on the phone (local cache remains).
4. The mechanism is a **template** the other three data types reuse later with minimal
   new design.

## Non-goals (this slice)

- memories / notes / notifications (next slices, same pattern).
- Public mesh changes (untouched).
- Phone as a first-class CRDT **writer** (it stays a spoke; the hub writes to the CRDT
  on its behalf).
- A new pairing flow (reuse the existing consumer pairing / allow-list).
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

## Part B — mobile: tasks spoke (no CRDT on the phone)

**B1. Hub side** — a `sync-control` verb set on the forward-control transport family
(extend `forward-control.ts` or add a sibling `sync-control.ts` reusing
`topicForPair` + the consumer allow-list):
- `tasks.pull { sinceCursor }` → `{ tasks: MeshTask[], cursor }` (changed since cursor).
- `tasks.push { deltas: MeshTask[] }` → applies each via `publishTask`/`deleteTask` into
  the hub's `MeshGraph`; returns `{ ok, cursor }`.
- **Authorization is the existing one:** the phone is already an allow-listed consumer
  of the hub; the Noise handshake on the per-pair topic IS the auth. No new token, no
  new pairing. (If the phone is not yet an allowed consumer, sync is simply unavailable —
  same gate as delegated inference.)

**B2. Phone side** — `apps/mobile/worklets/sync-worklet.mjs` (clone of
`forward-worklet.mjs`): Hyperswarm in Bare, dials the hub's sync topic, does
push/pull request-response (newline-JSON, same framing as forward). A
`apps/mobile/syncClient.ts` RN bridge (mirrors `forwardWorklet.ts`) exposes
`pullTasks(cursor)` / `pushTasks(deltas)`.

**B3. Reconcile** — `apps/mobile/tasks.ts` gains a sync layer: persist a `lastCursor`;
on app foreground / a timer (e.g. 30s while Tasks is open) / manual "Sync now":
1. `pushTasks(localChangesSince(lastCursor))`,
2. `pullTasks(lastCursor)` → merge LWW into the local store,
3. advance `lastCursor`.
Local store stays the offline cache; merges are LWW by `updatedAt`.

**B4. UI** — a sync-status chip on `TasksScreen` (synced ✓ / syncing… / offline) + a
"Sync now" action. Offline = hub unreachable; the screen still works on the local cache.

*Acceptance for Part B:* phone (paired) pulls a desktop-created task; edits it offline;
on reconnect both desktops reflect the edit; a delete on the phone tombstones everywhere.

## Identity / transport / security

- **Hub** = the phone's already-paired provider node (`apps/mobile/mesh.ts`
  `providerKey`). One hub per phone in this slice.
- **Topic** = a per-pair topic in the forward-control family
  (`sha256("hypha-sync-v1:" + hubKey + phoneConsumerKey)` — a `-sync-v1` sibling of the
  forward topic so the two channels don't collide). Honors CLAUDE.md seed rules: it's a
  derived per-pair topic announced on forward-control's own swarm, **not** a second
  Hyperswarm under the raw device seed.
- **Encryption** = Hyperswarm Noise (transport). Data-at-rest on the hub is the existing
  Corestore (unencrypted on disk) — unchanged by this slice; acceptable for a
  single-user trusted mesh, same as today.
- **Authorization** = the consumer allow-list the hub already enforces for forward/
  delegated paths.

## Testing / verification

- **Unit (`packages/mesh`):** LWW apply — out-of-order task updates converge to the
  greatest `updatedAt`; `task-delete` tombstones; `tasksSince(cursor)` returns the right
  delta. Reuse the spike harness style in `spike/05-autobase-pairing.ts` (two in-process
  graphs, replicate over loopback, assert convergence).
- **Integration (hypha):** two hypha instances paired over loopback; `POST /tasks` on
  one → `GET /tasks` on the other converges; SSE emits.
- **Mobile:** `tsc --noEmit` + `expo export -p ios` bundle; on-device — pull a
  desktop task, edit offline (airplane mode), reconnect, confirm convergence + tombstone.
- **Regression:** desktop chat/cron/daemons that read tasks still work (the web reads via
  hypha; the local-file fallback covers hypha-down).

## Risks & mitigations

- **Web reads now depend on hypha being up.** Mitigation: local-file read-through
  fallback (degraded read-only) when hypha is unreachable; writes queue/fail visibly.
- **`sync-worklet` is a second Bare worklet alongside `forward-worklet`.** Mitigation:
  same proven pattern; distinct topic; one request in flight (as forward already does).
- **Clock skew mis-orders same-task edits.** Accepted (documented); revisit with a
  logical clock if it bites.
- **Migration double-import.** Mitigation: idempotent (LWW by id) + a `tasks-migrated`
  marker.

## Implementation phasing (for the plan)

1. **mesh data model** — entry types + apply + `MeshGraph` methods + unit tests.
2. **hypha task endpoints** — shim routes + `MeshEventBus` emit + integration test.
3. **web tasks-client** — proxy route + `TasksPanel` wiring + migration; verify two-desktop sync.
4. **hub sync-control** — `tasks.pull`/`tasks.push` verbs over the per-pair topic.
5. **mobile sync** — `sync-worklet` + `syncClient` + `tasks.ts` reconcile + status UI.
6. **end-to-end verify** — desktop↔desktop↔phone, including offline + delete; sawdust entry.

Each phase: `tsc`/build sanity, then the phase's acceptance check.
