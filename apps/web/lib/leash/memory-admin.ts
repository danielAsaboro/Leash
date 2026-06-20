/**
 * Memory administration (server-only) — the Brain → Memory tab's read/forget layer.
 *
 *   · local context: list legacy markdown snippets (with preview + chunk count) and REALLY delete —
 *     `rm` the file; the graph's directory-fingerprint cache re-embeds on next search
 *   · activity: paginated, newest-first view of the watcher trail (tombstone-filtered);
 *     forgetting tombstones the record (the JSONL is never rewritten — watcher-contended)
 *   · stats: what the RAG index currently holds
 */
import "server-only";
import { readFile, rm, stat } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { NOTES_DIR, readActivityRecords, chunkText, type ActivityRecord, indexStats, type IndexStats } from "./graph.ts";
import { tombstone } from "./tombstones.ts";

export interface NoteView {
  file: string;
  bytes: number;
  mtimeMs: number;
  /** First ~200 chars of the note body. */
  preview: string;
  /** How many chunks this note contributes to the RAG index. */
  chunks: number;
}

/** All notes, newest-modified first. */
export async function listNotes(): Promise<NoteView[]> {
  if (!existsSync(NOTES_DIR)) return [];
  const files = readdirSync(NOTES_DIR).filter((n) => n.endsWith(".md"));
  const notes = await Promise.all(
    files.map(async (f) => {
      try {
        const [text, s] = await Promise.all([readFile(join(NOTES_DIR, f), "utf8"), stat(join(NOTES_DIR, f))]);
        return {
          file: f,
          bytes: s.size,
          mtimeMs: s.mtimeMs,
          preview: text.replace(/\s+/g, " ").trim().slice(0, 200),
          chunks: chunkText(text).length,
        };
      } catch {
        return null;
      }
    }),
  );
  return notes.filter((n): n is NoteView => n !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Delete a legacy local-context file. Basename-only (no path traversal). */
export async function deleteNote(file: string): Promise<boolean> {
  const name = basename(file);
  if (!name.endsWith(".md")) return false;
  try {
    await rm(join(NOTES_DIR, name));
    return true;
  } catch {
    return false;
  }
}

export interface ActivityPage {
  records: ActivityRecord[];
  total: number;
  offset: number;
}

/** Newest-first page of the (tombstone-filtered) activity trail. */
export async function activityPage(offset = 0, limit = 50): Promise<ActivityPage> {
  const all = (await readActivityRecords()).reverse();
  return { records: all.slice(offset, offset + limit), total: all.length, offset };
}

/** Tombstone one activity record by `ts`. */
export async function forgetActivity(ts: string): Promise<void> {
  await tombstone(ts);
}

export type { IndexStats };
export { indexStats };
