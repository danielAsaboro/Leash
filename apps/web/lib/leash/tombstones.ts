/**
 * Activity tombstones (server-only) — `data/leash-activity-tombstones.json`.
 *
 * "Forgetting" an activity record must NOT rewrite `leash-activity.jsonl`: the watcher
 * appends to it concurrently and a rewrite would race a torn line (or resurrect what a
 * concurrent append dropped). Instead we tombstone the record's timestamp and every
 * reader (graph index, activity tools, memory browser) filters through `isTombstoned`.
 * Timestamps are unique per record — the watcher emits one observation per cycle.
 */
import "server-only";
import { join } from "node:path";
import { statSync } from "node:fs";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";

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

/** Tombstone one record by its `ts` (idempotent). */
export async function tombstone(ts: string): Promise<void> {
  const set = await tombstonedSet();
  if (set.has(ts)) return;
  set.add(ts);
  await writeJson(TOMBSTONES_FILE, { tombstoned: [...set].sort() });
  invalidateJsonCache(TOMBSTONES_FILE);
}

/** The tombstone file's mtime (0 when absent) — part of the activity embed-cache key. */
export function tombstonesMtime(): number {
  try {
    return statSync(TOMBSTONES_FILE).mtimeMs;
  } catch {
    return 0;
  }
}
