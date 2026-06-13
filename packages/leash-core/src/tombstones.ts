/**
 * Activity tombstones — `data/leash-activity-tombstones.json`. Moved into
 * `@mycelium/leash-core` (web keeps a re-export shim) so both the web process and the
 * `leash-tools-mcp` Context group read the same forget-set.
 *
 * "Forgetting" an activity record must NOT rewrite `leash-activity.jsonl`: the watcher
 * appends to it concurrently and a rewrite would race a torn line. Instead we tombstone the
 * record's timestamp and every reader filters through `tombstonedSet`. The write is now
 * wrapped in a cross-process file lock (web + daemon may both forget).
 */
import { join } from "node:path";
import { statSync } from "node:fs";
import { readJsonCached, writeJson, invalidateJsonCache } from "./json-store.ts";
import { DATA_DIR } from "./paths.ts";
import { withFileLock } from "./lock.ts";

export const TOMBSTONES_FILE = process.env["LEASH_ACTIVITY_TOMBSTONES"] ?? join(DATA_DIR, "leash-activity-tombstones.json");

interface TombstoneStore {
  /** ISO `ts` values of forgotten activity records. */
  tombstoned: string[];
}

/** The tombstoned `ts` set (mtime-cached read). */
export async function tombstonedSet(): Promise<Set<string>> {
  const raw = await readJsonCached<TombstoneStore>(TOMBSTONES_FILE, { tombstoned: [] });
  return new Set(Array.isArray(raw?.tombstoned) ? raw.tombstoned.filter((t): t is string => typeof t === "string") : []);
}

/** Tombstone one record by its `ts` (idempotent, cross-process safe). */
export async function tombstone(ts: string): Promise<void> {
  await withFileLock(TOMBSTONES_FILE, async () => {
    const set = await tombstonedSet();
    if (set.has(ts)) return;
    set.add(ts);
    await writeJson(TOMBSTONES_FILE, { tombstoned: [...set].sort() });
    invalidateJsonCache(TOMBSTONES_FILE);
  });
}

/** The tombstone file's mtime (0 when absent) — part of the activity embed-cache key. */
export function tombstonesMtime(): number {
  try {
    return statSync(TOMBSTONES_FILE).mtimeMs;
  } catch {
    return 0;
  }
}
