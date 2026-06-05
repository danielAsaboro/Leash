/**
 * The activity trail — a tiny JSONL appender (NOT GraphStore; a different shape).
 *
 * One {ts,app,window,summary,tags} record per line. The web tools read this file
 * directly and the graph ingest embeds it; `forgetLastMinutes` is the privacy
 * "forget last N minutes" control (rewrites the file dropping recent records).
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ACTIVITY_LOG } from "./config.ts";

export interface ActivityRecord {
  ts: string;
  app: string;
  window: string;
  summary: string;
  tags: string[];
}

/** Append one record as a JSONL line (creates the dir/file on first write). */
export function appendRecord(rec: ActivityRecord): void {
  mkdirSync(dirname(ACTIVITY_LOG), { recursive: true });
  appendFileSync(ACTIVITY_LOG, JSON.stringify(rec) + "\n");
}

/** Read all records (lenient per-line parse; `[]` if the file is missing). */
export function readRecords(): ActivityRecord[] {
  let raw: string;
  try {
    raw = readFileSync(ACTIVITY_LOG, "utf-8");
  } catch {
    return [];
  }
  const out: ActivityRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as ActivityRecord);
    } catch {
      /* skip a torn/partial line */
    }
  }
  return out;
}

/** Forget the last N minutes: rewrite the file dropping records newer than the cutoff. Returns the count dropped. */
export function forgetLastMinutes(n: number): number {
  const records = readRecords();
  if (records.length === 0) return 0;
  const cutoff = Date.now() - n * 60000;
  const kept = records.filter((r) => new Date(r.ts).getTime() < cutoff);
  const dropped = records.length - kept.length;
  if (dropped > 0) {
    mkdirSync(dirname(ACTIVITY_LOG), { recursive: true });
    writeFileSync(ACTIVITY_LOG, kept.length ? kept.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
  }
  return dropped;
}
