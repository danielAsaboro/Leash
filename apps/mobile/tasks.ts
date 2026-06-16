/**
 * On-device task store — the standalone analogue of the desktop tasks-store (packages/leash-core).
 * The phone owns its own to-do list; everything is one JSON file in the app's document directory.
 * Field names + enums mirror the web LeashTask so the mobile Tasks → Mine tab is a true 1:1 of
 * the desktop TasksPanel (status open/in_progress/done/dropped, priority low/normal/high).
 */
import * as FileSystem from "expo-file-system/legacy";

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
  const list = sortTasks(await readAll());
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
  await writeAll(list);
  return task;
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, "title" | "detail" | "status" | "priority" | "tags">>,
): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((t) => t.id === id);
  if (i === -1) return;
  list[i] = { ...list[i]!, ...patch, updatedAt: Date.now() };
  await writeAll(list);
}

export async function deleteTask(id: string): Promise<void> {
  await writeAll((await readAll()).filter((t) => t.id !== id));
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
