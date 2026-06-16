/**
 * Mesh task bridge (server-only): the web's read/write path to the replicated task CRDT, via the
 * local Hypha daemon's `/tasks*` HTTP API (the daemon owns the mesh; this only talks HTTP to it).
 *
 * Design (spec §Mesh-native task sync): the MESH is the source of truth for the synced view; the
 * local `leash-tasks.json` store is a **read-through cache / offline fallback** (and what the
 * assistant's chat tools + the leash-tools-mcp Tasks group still write). So:
 *   - reads  → {@link listTasksMerged}: local ∪ mesh, LWW by `updatedAt`, mesh tombstones applied.
 *   - writes → {@link syncTaskToMesh}/{@link deleteTaskFromMesh}: best-effort write-through from the
 *     existing `/api/leash/tasks*` routes (which keep writing local synchronously). Hypha down →
 *     the write-through is a no-op and the local store still serves the page (honest degraded mode).
 *
 * `MeshTask` is a superset of `LeashTask` — identical except `chatIds` (which the mesh/phone don't
 * carry; preserved locally on the originating device).
 */
import "server-only";
import { loadTasks, type LeashTask, type TaskFilter, type TaskStatus, type TaskSource, type TaskPriority, TASK_STATUSES, TASK_PRIORITIES } from "./tasks-store.ts";

const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${HYPHA_PORT}`;
/** Mesh ops are best-effort and must never stall a page render — short, hard timeout. */
const TIMEOUT_MS = 2500;

/** The on-the-wire MeshTask shape (the hypha `/tasks` contract). `status`/`priority`/`source` are
 *  free strings on the wire; {@link meshToLeash} coerces them back into the local enums. */
interface MeshTaskWire {
  id: string;
  title: string;
  detail?: string;
  status: string;
  priority: string;
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

const KNOWN_SOURCES: readonly TaskSource[] = ["user", "assistant", "dream", "cron", "research", "evolve"];

/** A LeashTask → the mesh wire shape (drops `chatIds`, which the mesh doesn't carry). */
function leashToMesh(t: LeashTask): MeshTaskWire {
  return {
    id: t.id,
    title: t.title,
    ...(t.detail ? { detail: t.detail } : {}),
    status: t.status,
    priority: t.priority,
    tags: t.tags,
    source: t.source,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** A mesh wire task → a LeashTask, coercing enums and re-attaching the local `chatIds` if we have
 *  this id locally (a remote-originated task has none on this device). */
function meshToLeash(m: MeshTaskWire, local?: LeashTask): LeashTask {
  return {
    id: m.id,
    title: m.title,
    ...(m.detail ? { detail: m.detail } : {}),
    status: TASK_STATUSES.includes(m.status as TaskStatus) ? (m.status as TaskStatus) : "open",
    priority: TASK_PRIORITIES.includes(m.priority as TaskPriority) ? (m.priority as TaskPriority) : "normal",
    tags: Array.isArray(m.tags) ? m.tags : [],
    source: KNOWN_SOURCES.includes(m.source as TaskSource) ? (m.source as TaskSource) : "user",
    chatIds: local?.chatIds ?? [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/** All mesh tasks INCLUDING tombstones since `cursor` (0 = everything) — the overlay source. */
async function meshTasksSince(cursor = 0): Promise<MeshTaskWire[]> {
  const r = await fetch(`${BASE}/tasks/since?cursor=${cursor}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!r.ok) throw new Error(`hypha /tasks/since ${r.status}`);
  return ((await r.json()) as { tasks?: MeshTaskWire[] }).tasks ?? [];
}

/** Push one task into the mesh (LWW upsert). Best-effort: never throws (hypha may be down). */
export async function syncTaskToMesh(t: LeashTask): Promise<void> {
  try {
    await fetch(`${BASE}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(leashToMesh(t)), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    /* hypha down → the local write already happened; the mesh catches up on the next online edit */
  }
}

/** Tombstone one task in the mesh. Best-effort: never throws. */
export async function deleteTaskFromMesh(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/tasks/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    /* hypha down → local delete already happened */
  }
}

/** Apply the local list filter + ordering (mirrors tasks-store.listTasks, post-merge). */
function filterAndSort(tasks: LeashTask[], filter: TaskFilter): LeashTask[] {
  const order: Record<TaskStatus, number> = { in_progress: 0, open: 1, done: 2, dropped: 3 };
  const q = filter.q?.trim().toLowerCase();
  return tasks
    .filter((t) => !filter.status || t.status === filter.status)
    .filter((t) => !filter.source || t.source === filter.source)
    .filter((t) => !filter.tag || t.tags.includes(filter.tag))
    .filter((t) => !q || `${t.title} ${t.detail ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => order[a.status] - order[b.status] || b.updatedAt - a.updatedAt);
}

/**
 * The synced task view: the local store overlaid with the mesh (LWW by `updatedAt`, mesh tombstones
 * removing tasks deleted on another device), then filtered + sorted exactly like the local list. If
 * hypha is down, falls back to the local store alone (the offline cache) — never throws.
 */
export async function listTasksMerged(filter: TaskFilter = {}): Promise<LeashTask[]> {
  const local = await loadTasks();
  let mesh: MeshTaskWire[];
  try {
    mesh = await meshTasksSince(0);
  } catch {
    return filterAndSort(local, filter); // hypha down → local-only fallback
  }
  const byId = new Map(local.map((t) => [t.id, t]));
  for (const m of mesh) {
    const cur = byId.get(m.id);
    if (m.deleted) {
      if (cur && m.updatedAt >= cur.updatedAt) byId.delete(m.id); // remote delete wins
    } else if (!cur || m.updatedAt > cur.updatedAt) {
      byId.set(m.id, meshToLeash(m, cur)); // remote create/edit wins
    }
  }
  return filterAndSort([...byId.values()], filter);
}
