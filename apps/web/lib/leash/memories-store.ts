/**
 * Typed memories (server-only) — `data/leash-memories.json`.
 *
 * The third kind of memory beside notes (documents) and the activity trail (episodes):
 * ATOMIC, TYPED items the assistant and the user save deliberately.
 *
 *   · preference — how the user likes things done → INJECTED into the system prompt
 *   · fact       — stable truths about the user/world → retrieval (recall + RAG)
 *   · goal       — desired end-states → retrieval
 *   · person     — people and relationships → retrieval
 *   · routine    — recurring patterns → retrieval
 *
 * Same discipline as tasks-store: in-process mutex, fresh read per mutation, atomic
 * write, mtime-cached loads. Single-writer file (web process only — chat tools and the
 * dashboard UI both run here), so deletes are real deletes, no tombstones.
 */
import "server-only";
import { generateId } from "ai";
import { join } from "node:path";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";

export const MEMORIES_FILE = process.env["LEASH_MEMORIES_FILE"] ?? join(DATA_DIR, "leash-memories.json");

export type MemoryType = "preference" | "fact" | "goal" | "person" | "routine";
export const MEMORY_TYPES: readonly MemoryType[] = ["preference", "fact", "goal", "person", "routine"];

export interface LeashMemory {
  id: string;
  type: MemoryType;
  text: string;
  source: "user" | "assistant";
  chatIds: string[];
  createdAt: number;
  updatedAt: number;
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => undefined);
  return run;
}

function normalize(raw: unknown): LeashMemory[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Partial<LeashMemory>[])
    .filter((m) => m && typeof m.id === "string" && typeof m.text === "string" && MEMORY_TYPES.includes(m.type as MemoryType))
    .map((m) => ({
      id: m.id as string,
      type: m.type as MemoryType,
      text: m.text as string,
      source: m.source === "assistant" ? "assistant" : "user",
      chatIds: Array.isArray(m.chatIds) ? m.chatIds.filter((x): x is string => typeof x === "string") : [],
      createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : Date.now(),
    }));
}

/** All memories (mtime-cached read). */
export async function loadMemories(): Promise<LeashMemory[]> {
  return normalize(await readJsonCached<unknown>(MEMORIES_FILE, []));
}

/** Filtered memories, newest first. `q` is a case-insensitive substring match. */
export async function listMemories(filter: { type?: MemoryType; q?: string } = {}): Promise<LeashMemory[]> {
  const q = filter.q?.trim().toLowerCase();
  return (await loadMemories())
    .filter((m) => !filter.type || m.type === filter.type)
    .filter((m) => !q || m.text.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The preference texts for system-prompt injection (newest first, caller caps). */
export async function preferenceTexts(): Promise<string[]> {
  return (await listMemories({ type: "preference" })).map((m) => m.text);
}

/** Save a new memory. Near-duplicate texts of the same type update instead of append. */
export async function addMemory(input: { type: MemoryType; text: string; source: "user" | "assistant"; chatId?: string }): Promise<LeashMemory> {
  return withLock(async () => {
    const memories = await loadMemories();
    const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
    const now = Date.now();
    const existing = memories.find((m) => m.type === input.type && m.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      existing.updatedAt = now;
      if (input.chatId) existing.chatIds = [...new Set([...existing.chatIds, input.chatId])];
      await writeJson(MEMORIES_FILE, memories);
      invalidateJsonCache(MEMORIES_FILE);
      return existing;
    }
    const memory: LeashMemory = {
      id: generateId(),
      type: input.type,
      text,
      source: input.source,
      chatIds: input.chatId ? [input.chatId] : [],
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(MEMORIES_FILE, [...memories, memory]);
    invalidateJsonCache(MEMORIES_FILE);
    return memory;
  });
}

/** Edit a memory's text/type. Returns the updated memory or null. */
export async function updateMemory(id: string, patch: { type?: MemoryType; text?: string }): Promise<LeashMemory | null> {
  return withLock(async () => {
    const memories = await loadMemories();
    const m = memories.find((x) => x.id === id);
    if (!m) return null;
    if (patch.type && MEMORY_TYPES.includes(patch.type)) m.type = patch.type;
    if (patch.text?.trim()) m.text = patch.text.replace(/\s+/g, " ").trim().slice(0, 500);
    m.updatedAt = Date.now();
    await writeJson(MEMORIES_FILE, memories);
    invalidateJsonCache(MEMORIES_FILE);
    return m;
  });
}

/** Forget (delete) a memory. */
export async function deleteMemory(id: string): Promise<boolean> {
  return withLock(async () => {
    const memories = await loadMemories();
    const next = memories.filter((m) => m.id !== id);
    if (next.length === memories.length) return false;
    await writeJson(MEMORIES_FILE, next);
    invalidateJsonCache(MEMORIES_FILE);
    return true;
  });
}
