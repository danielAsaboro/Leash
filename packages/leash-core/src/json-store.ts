/**
 * Shared file-backed JSON store helper — the `chat-store.ts` pattern, factored once for
 * the dashboard's stores (prompts, tools, tasks, tombstones, …). Moved into
 * `@mycelium/leash-core` so the `leash-tools-mcp` daemon shares ONE implementation with
 * the web process (the old `apps/web/lib/leash/json-store.ts` is now a re-export shim).
 *
 *   · `readJson`   — lenient read (fallback on missing/garbled file)
 *   · `writeJson`  — ATOMIC write: tmp file + `rename` so a concurrent reader never
 *                    sees a torn file (several stores are read on every chat turn)
 *   · `readJsonCached` — tiny mtime-keyed cache so per-turn reads cost a `stat`, not a
 *                    full read+parse, and external edits (hand-editing, ANOTHER process
 *                    writing) are picked up without a restart
 *
 * `DATA_DIR` now comes from `paths.ts` (repo-root-anchored), so both processes resolve
 * the same `mycelium/data` regardless of where the compiled module sits.
 */
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./paths.ts";

export { DATA_DIR };

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
const caches = ((globalThis as Record<string, unknown>)["__leashJsonCache"] ??= new Map<string, CacheEntry>()) as Map<string, CacheEntry>;

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
