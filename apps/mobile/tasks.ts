/**
 * On-device task store — the standalone analogue of the desktop tasks-store (packages/leash-core).
 * The phone owns its own to-do list in one JSON file in the app's document directory, which doubles
 * as an **offline replica cache**: once the phone JOINS the private mesh (Mesh tab → "Join a mesh"),
 * the mesh worklet (meshClient) becomes the source of truth — reads LWW-merge the replicated CRDT
 * over the local cache (remote deletes applied via tombstones), and writes go to BOTH the local
 * cache (instant render) and the mesh (best-effort write-through). Mesh-less → pure local, as before.
 * Field names + enums mirror the web LeashTask so the mobile Tasks → Mine tab is a true 1:1 of
 * the desktop TasksPanel (status open/in_progress/done/dropped, priority low/normal/high).
 */
import * as FileSystem from "expo-file-system/legacy";
import * as meshClient from "./meshClient";
import type { MeshTask } from "./meshClient";

export type TaskStatus = "open" | "in_progress" | "done" | "dropped";
export type TaskPriority = "low" | "normal" | "high";
export type TaskSource = "user" | "assistant";

export type Task = {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

export const STATUSES: TaskStatus[] = ["open", "in_progress", "done", "dropped"];
export const PRIORITIES: TaskPriority[] = ["low", "normal", "high"];

const FILE = `${FileSystem.documentDirectory}tasks.json`;

function newId(): string {
  return `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function readAll(): Promise<Task[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const arr = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Task[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Task[]): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

/** A mesh CRDT task → the local Task shape (coerce source to the phone's two-value enum). */
function fromMesh(m: MeshTask): Task {
  return {
    id: m.id,
    title: m.title,
    detail: m.detail || undefined,
    status: m.status,
    priority: m.priority,
    source: m.source === "assistant" ? "assistant" : "user",
    tags: Array.isArray(m.tags) ? m.tags : [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/**
 * The synced view when the phone is in a mesh: LWW-merge the worklet's task list (incl. tombstones)
 * over the local replica cache, persist the merged result, and return it. Falls back to the local
 * cache when the phone isn't in a mesh or the worklet isn't reachable. Never throws.
 */
async function mergedFromMesh(local: Task[]): Promise<Task[] | null> {
  try {
    const status = await meshClient.meshStatus();
    if (!status.joined) return null; // mesh-less → caller uses the local cache
    const mesh = await meshClient.listTasks(); // includes tombstones
    const byId = new Map(local.map((t) => [t.id, t]));
    for (const m of mesh) {
      const cur = byId.get(m.id);
      if (m.deleted) {
        if (cur && m.updatedAt >= cur.updatedAt) byId.delete(m.id); // remote delete wins
      } else if (!cur || m.updatedAt >= cur.updatedAt) {
        byId.set(m.id, fromMesh(m)); // remote create/edit wins
      }
    }
    const merged = [...byId.values()];
    await writeAll(merged); // refresh the offline cache from the mesh
    return merged;
  } catch {
    return null; // worklet not ready → local cache
  }
}

/** Open/in-progress first, then by priority, then newest. */
function sortTasks(list: Task[]): Task[] {
  const statusRank: Record<TaskStatus, number> = { in_progress: 0, open: 1, done: 2, dropped: 3 };
  const prioRank: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
  return list.sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      prioRank[a.priority] - prioRank[b.priority] ||
      b.updatedAt - a.updatedAt,
  );
}

export async function listTasks(filter?: TaskStatus | "all"): Promise<Task[]> {
  const local = await readAll();
  const merged = await mergedFromMesh(local); // mesh source when joined; null → local cache
  const list = sortTasks(merged ?? local);
  if (!filter || filter === "all") return list;
  return list.filter((t) => t.status === filter);
}

export async function createTask(input: {
  title: string;
  detail?: string;
  priority?: TaskPriority;
  source?: TaskSource;
  tags?: string[];
}): Promise<Task> {
  const now = Date.now();
  const task: Task = {
    id: newId(),
    title: input.title.trim(),
    detail: input.detail?.trim() || undefined,
    status: "open",
    priority: input.priority ?? "normal",
    source: input.source ?? "user",
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  const list = await readAll();
  list.push(task);
  await writeAll(list); // instant local render
  void meshClient.upsertTask(task).catch(() => {}); // best-effort replicate to the mesh
  return task;
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, "title" | "detail" | "status" | "priority" | "tags">>,
): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((t) => t.id === id);
  if (i === -1) return;
  const next = { ...list[i]!, ...patch, updatedAt: Date.now() };
  list[i] = next;
  await writeAll(list);
  void meshClient.upsertTask(next).catch(() => {}); // best-effort replicate the edit
}

export async function deleteTask(id: string): Promise<void> {
  await writeAll((await readAll()).filter((t) => t.id !== id));
  void meshClient.deleteTask(id).catch(() => {}); // best-effort tombstone in the mesh
}

export async function clearTasks(): Promise<void> {
  await FileSystem.deleteAsync(FILE, { idempotent: true }).catch(() => {});
}

export type TaskCounts = { open: number; in_progress: number; done: number; dropped: number; total: number };

export async function taskCounts(): Promise<TaskCounts> {
  const list = await readAll();
  const c: TaskCounts = { open: 0, in_progress: 0, done: 0, dropped: 0, total: list.length };
  for (const t of list) c[t.status] += 1;
  return c;
}
