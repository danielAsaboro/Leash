/**
 * Shared file-backed JSON store helper (server-only) — the `chat-store.ts` pattern,
 * factored once for the dashboard's stores (prompts, tools, tasks, tombstones, …).
 *
 *   · `readJson`   — lenient read (fallback on missing/garbled file)
 *   · `writeJson`  — ATOMIC write: tmp file + `rename` so a concurrent reader never
 *                    sees a torn file (several stores are read on every chat turn)
 *   · `mtimeCached`— tiny mtime-keyed cache so per-turn reads cost a `stat`, not a
 *                    full read+parse, and external edits (hand-editing the JSON,
 *                    another process writing) are picked up without a restart
 *
 * All stores live in `mycelium/data/` next to the existing leash files; every path
 * is env-overridable from the caller (same convention as LEASH_CHAT_DIR).
 */
import "server-only";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data/. All dashboard stores live here. */
export const DATA_DIR = join(here, "..", "..", "..", "..", "data");

/** Lenient JSON read — `fallback` on missing file or parse error. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic JSON write: tmp + rename, creating the parent dir on first use. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

interface CacheEntry {
  mtimeMs: number;
  value: unknown;
}
/** Per-process cache, on globalThis so Next dev HMR doesn't silently fork it. */
const caches = ((globalThis as Record<string, unknown>)["__leashJsonCache"] ??= new Map<string, CacheEntry>()) as Map<
  string,
  CacheEntry
>;

/**
 * Read `file` through an mtime-keyed cache: unchanged file → cached value (one `stat`);
 * changed/missing file → re-read. Missing file returns `fallback` (cached under mtime 0).
 */
export async function readJsonCached<T>(file: string, fallback: T): Promise<T> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    /* missing file → fallback below */
  }
  const hit = caches.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
  const value = mtimeMs === 0 ? fallback : await readJson(file, fallback);
  caches.set(file, { mtimeMs, value });
  return value;
}

/** Drop a file's cache entry (call after writing through a different path). */
export function invalidateJsonCache(file: string): void {
  caches.delete(file);
}
