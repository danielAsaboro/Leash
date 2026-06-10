/**
 * Storage usage + clearing for Settings → Storage (server-only).
 *
 * SAFETY: clearing is restricted to the hardcoded `CLEARABLE` allow-list of user-content
 * categories. It deliberately NEVER includes device identity (`seed.txt`), the mesh corestores
 * (`hypha*`, `adapters`, `evolve`), the economy ledger, or secrets — wiping those would break the
 * device, drop it from its mesh, or lose money. Clearing EMPTIES a category (keeps the dir so the
 * app keeps working); it never deletes the directory itself.
 */
import "server-only";
import { stat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./json-store.ts";
import { modelsDiskUsage } from "./models.ts";

/** User-content categories safe to clear. Paths are relative to DATA_DIR. */
export const CLEARABLE: { category: string; label: string; paths: string[] }[] = [
  { category: "chats", label: "Chat history", paths: ["leash-chats"] },
  { category: "research", label: "Research", paths: ["leash-research"] },
  { category: "downloads", label: "Downloads", paths: ["leash-downloads"] },
  { category: "photos", label: "Photos", paths: ["photos", "leash-photo-tags.json"] },
  { category: "voice", label: "Voice notes", paths: ["voice"] },
  { category: "notes", label: "Notes", paths: ["notes"] },
  { category: "activity", label: "Activity log", paths: ["leash-activity.jsonl", "leash-activity-tombstones.json"] },
];

/** Recursive byte size of a file or dir; 0 if missing. */
async function pathSize(p: string): Promise<number> {
  try {
    const s = await stat(p);
    if (s.isFile()) return s.size;
    if (s.isDirectory()) {
      let total = 0;
      for (const n of await readdir(p)) total += await pathSize(join(p, n));
      return total;
    }
  } catch {
    /* missing */
  }
  return 0;
}

/** Empty a path's contents (keep a directory; delete a file). */
async function emptyPath(abs: string): Promise<void> {
  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      for (const n of await readdir(abs)) await rm(join(abs, n), { recursive: true, force: true });
    } else {
      await rm(abs, { force: true });
    }
  } catch {
    /* missing */
  }
}

export interface StorageUsage {
  modelBytes: number;
  modelFiles: { file: string; bytes: number }[];
  data: { category: string; label: string; bytes: number }[];
  totalBytes: number;
}

export async function storageUsage(): Promise<StorageUsage> {
  const disk = await modelsDiskUsage();
  const data = await Promise.all(
    CLEARABLE.map(async (c) => ({
      category: c.category,
      label: c.label,
      bytes: (await Promise.all(c.paths.map((p) => pathSize(join(DATA_DIR, p))))).reduce((a, b) => a + b, 0),
    })),
  );
  const dataBytes = data.reduce((a, d) => a + d.bytes, 0);
  return { modelBytes: disk.totalBytes, modelFiles: disk.files, data, totalBytes: disk.totalBytes + dataBytes };
}

/** Clear one allow-listed category. Returns false for an unknown/non-clearable category. */
export async function clearCategory(category: string): Promise<boolean> {
  const entry = CLEARABLE.find((c) => c.category === category);
  if (!entry) return false;
  for (const p of entry.paths) await emptyPath(join(DATA_DIR, p));
  return true;
}
