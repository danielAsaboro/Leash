/**
 * Typed memories — `data/leash-memories.json`. Moved into `@mycelium/leash-core` (web keeps
 * a re-export shim) so the `leash-tools-mcp` Memory group and the web process share ONE
 * implementation over the same file.
 *
 *   · preference — how the user likes things done → INJECTED into the system prompt
 *   · fact / goal / person / routine → retrieval (recall + RAG)
 *
 * Discipline: in-process mutex (fast path) NESTING a cross-process file lock (now that two
 * processes write), fresh read per mutation, atomic write, mtime-cached loads.
 */
import { generateId } from "ai";
import { join } from "node:path";
import { readJsonCached, writeJson, invalidateJsonCache } from "./json-store.ts";
import { DATA_DIR } from "./paths.ts";
import { withFileLock } from "./lock.ts";

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

/** In-process serialize THEN cross-process lock — the read-modify-write runs under both. */
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(() => withFileLock(MEMORIES_FILE, fn));
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

/** Common words dropped from a `q` so a natural-language query ("what does the user prefer?")
 *  matches on its CONTENT words, not the filler. */
const RECALL_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "was", "were", "be", "been",
  "what", "who", "whom", "whose", "does", "do", "did", "my", "me", "you", "your", "yours",
  "about", "that", "this", "these", "those", "its", "on", "in", "into", "with", "how",
  "when", "where", "which", "why", "can", "could", "would", "should", "have", "has", "had",
]);

/** Filtered memories, newest first. `q` matches on the query's CONTENT WORDS (any-of), so a
 *  natural-language question — what `recall` passes — finds the relevant memory; it falls back to a
 *  substring match when the query has no content words (a short/keyword query like "ssd" still works). */
export async function listMemories(filter: { type?: MemoryType; q?: string } = {}): Promise<LeashMemory[]> {
  const q = filter.q?.trim().toLowerCase();
  const words = q ? [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !RECALL_STOPWORDS.has(w)))] : [];
  const matches = (text: string): boolean => {
    if (!q) return true;
    const t = text.toLowerCase();
    return words.length > 0 ? words.some((w) => t.includes(w)) : t.includes(q);
  };
  return (await loadMemories())
    .filter((m) => !filter.type || m.type === filter.type)
    .filter((m) => matches(m.text))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The preference texts for system-prompt injection (newest first, caller caps). */
export async function preferenceTexts(): Promise<string[]> {
  return (await listMemories({ type: "preference" })).map((m) => m.text);
}

/** Save a new memory. Near-duplicate texts of the same type update instead of append. */
export async function addMemory(input: { type: MemoryType; text: string; source: "user" | "assistant"; chatId?: string }): Promise<LeashMemory> {
  return mutate(async () => {
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
  return mutate(async () => {
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
  return mutate(async () => {
    const memories = await loadMemories();
    const next = memories.filter((m) => m.id !== id);
    if (next.length === memories.length) return false;
    await writeJson(MEMORIES_FILE, next);
    invalidateJsonCache(MEMORIES_FILE);
    return true;
  });
}
