/**
 * File-based task store (server-only) — `data/leash-tasks.json`.
 *
 * One general task system with three writers:
 *   · the dashboard UI (CRUD at /tasks)
 *   · the assistant (create_task / update_task chat tools, stamped source:"assistant")
 *   · the dreaming pass (`scripts/dream.mts`, stamped source:"dream")
 *
 * First load migrates any legacy `data/leash-dreams.json` consolidations into tasks
 * (source:"dream") so the old store retires without losing anything. Mutations go
 * through an in-process promise-mutex with a fresh read per edit + atomic rename, so
 * concurrent chat-tool calls and UI edits never lose updates (the same discipline the
 * dashboard uses for qvac.config.base.json edits).
 */
import "server-only";
import { generateId } from "ai";
import { join } from "node:path";
import { readJson, readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import type { ConsolidationItem } from "./types.ts";

export const TASKS_FILE = process.env["LEASH_TASKS_FILE"] ?? join(DATA_DIR, "leash-tasks.json");
const DREAMS_FILE = process.env["LEASH_DREAMS_FILE"] ?? join(DATA_DIR, "leash-dreams.json");

export type TaskStatus = "open" | "in_progress" | "done" | "dropped";
export type TaskPriority = "low" | "normal" | "high";
export type TaskSource = "user" | "assistant" | "dream" | "cron";

export interface LeashTask {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  source: TaskSource;
  /** Chats this task was created from / discussed in. */
  chatIds: string[];
  createdAt: number;
  updatedAt: number;
}

export const TASK_STATUSES: readonly TaskStatus[] = ["open", "in_progress", "done", "dropped"];
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high"];

/** Serialize mutations within this process; the write itself is atomic (tmp+rename). */
let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => undefined);
  return run;
}

function normalize(raw: unknown): LeashTask[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Partial<LeashTask>[])
    .filter((t) => t && typeof t.id === "string" && typeof t.title === "string")
    .map((t) => ({
      id: t.id as string,
      title: t.title as string,
      ...(t.detail ? { detail: t.detail } : {}),
      status: TASK_STATUSES.includes(t.status as TaskStatus) ? (t.status as TaskStatus) : "open",
      priority: TASK_PRIORITIES.includes(t.priority as TaskPriority) ? (t.priority as TaskPriority) : "normal",
      tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [],
      source: t.source === "assistant" || t.source === "dream" || t.source === "cron" ? t.source : "user",
      chatIds: Array.isArray(t.chatIds) ? t.chatIds.filter((x): x is string => typeof x === "string") : [],
      createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
    }));
}

/** One-time migration: legacy dreams (`leash-dreams.json`) become source:"dream" tasks. */
async function migrateDreams(): Promise<LeashTask[]> {
  const dreams = await readJson<ConsolidationItem[]>(DREAMS_FILE, []);
  if (!Array.isArray(dreams) || dreams.length === 0) return [];
  const now = Date.now();
  return dreams
    .filter((d) => d && typeof d.title === "string" && d.title.trim())
    .map((d) => ({
      id: d.id || generateId(),
      title: d.title.trim().slice(0, 120),
      ...(d.detail ? { detail: String(d.detail).slice(0, 500) } : {}),
      status: "open" as const,
      priority: "normal" as const,
      tags: [],
      source: "dream" as const,
      chatIds: Array.isArray(d.chatIds) ? d.chatIds : [],
      createdAt: d.createdAt ?? now,
      updatedAt: d.createdAt ?? now,
    }));
}

/** All tasks (mtime-cached read; first call migrates legacy dreams into the file). */
export async function loadTasks(): Promise<LeashTask[]> {
  const raw = await readJsonCached<unknown>(TASKS_FILE, null);
  if (raw !== null) return normalize(raw);
  const migrated = await migrateDreams();
  await writeJson(TASKS_FILE, migrated);
  invalidateJsonCache(TASKS_FILE);
  return migrated;
}

export interface TaskFilter {
  status?: TaskStatus;
  source?: TaskSource;
  tag?: string;
  /** Case-insensitive substring over title+detail. */
  q?: string;
}

/** Filtered tasks, open work first, then most recently updated. */
export async function listTasks(filter: TaskFilter = {}): Promise<LeashTask[]> {
  const order: Record<TaskStatus, number> = { in_progress: 0, open: 1, done: 2, dropped: 3 };
  const q = filter.q?.trim().toLowerCase();
  return (await loadTasks())
    .filter((t) => !filter.status || t.status === filter.status)
    .filter((t) => !filter.source || t.source === filter.source)
    .filter((t) => !filter.tag || t.tags.includes(filter.tag))
    .filter((t) => !q || `${t.title} ${t.detail ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => order[a.status] - order[b.status] || b.updatedAt - a.updatedAt);
}

/** Open + in-progress counts for the overview card. */
export async function taskCounts(): Promise<{ open: number; inProgress: number; done: number }> {
  const tasks = await loadTasks();
  return {
    open: tasks.filter((t) => t.status === "open").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    done: tasks.filter((t) => t.status === "done").length,
  };
}

export interface NewTask {
  title: string;
  detail?: string;
  priority?: TaskPriority;
  tags?: string[];
  source?: TaskSource;
  chatId?: string;
}

/** Create a task (defaults: open / normal / source user). */
export async function createTask(input: NewTask): Promise<LeashTask> {
  return withLock(async () => {
    const tasks = await loadTasks();
    const now = Date.now();
    const task: LeashTask = {
      id: generateId(),
      title: input.title.trim().slice(0, 120),
      ...(input.detail?.trim() ? { detail: input.detail.trim().slice(0, 1000) } : {}),
      status: "open",
      priority: input.priority && TASK_PRIORITIES.includes(input.priority) ? input.priority : "normal",
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 8),
      source: input.source ?? "user",
      chatIds: input.chatId ? [input.chatId] : [],
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(TASKS_FILE, [...tasks, task]);
    invalidateJsonCache(TASKS_FILE);
    return task;
  });
}

export interface TaskPatch {
  title?: string;
  detail?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  /** A chat id to associate (appended, deduped). */
  chatId?: string;
}

/** Patch a task by id; returns the updated task or null if unknown. */
export async function updateTask(id: string, patch: TaskPatch): Promise<LeashTask | null> {
  return withLock(async () => {
    const tasks = await loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const prev = tasks[idx] as LeashTask;
    const next: LeashTask = {
      ...prev,
      ...(patch.title?.trim() ? { title: patch.title.trim().slice(0, 120) } : {}),
      ...(patch.detail?.trim() ? { detail: patch.detail.trim().slice(0, 1000) } : {}),
      ...(patch.status && TASK_STATUSES.includes(patch.status) ? { status: patch.status } : {}),
      ...(patch.priority && TASK_PRIORITIES.includes(patch.priority) ? { priority: patch.priority } : {}),
      ...(patch.tags ? { tags: patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 8) } : {}),
      ...(patch.chatId ? { chatIds: [...new Set([...prev.chatIds, patch.chatId])] } : {}),
      updatedAt: Date.now(),
    };
    // `detail: ""` clears the field (the spread above omitted it).
    if (patch.detail !== undefined && !patch.detail.trim()) delete (next as Partial<LeashTask>).detail;
    tasks[idx] = next;
    await writeJson(TASKS_FILE, tasks);
    invalidateJsonCache(TASKS_FILE);
    return next;
  });
}

/** Delete a task by id (returns whether it existed). */
export async function deleteTask(id: string): Promise<boolean> {
  return withLock(async () => {
    const tasks = await loadTasks();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    await writeJson(TASKS_FILE, next);
    invalidateJsonCache(TASKS_FILE);
    return true;
  });
}
