/**
 * Heartbeat runtime state (server-only) — `data/leash-heartbeat-state.json`.
 *
 * A small atomic JSON (scheduler-state in spirit) but WEB-owned: it holds the
 * proactive loop's memory between cycles — the per-day notification budget, per-check tier overrides
 * ("always do this" promotes ask→notify→auto for a recurring nudge), and recently-surfaced proposal
 * fingerprints so the same suggestion isn't repeated. All reads tolerate a missing/garbled file.
 */
import "server-only";
import { join } from "node:path";
import { readJson, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import type { Tier } from "./classify.ts";

export const HEARTBEAT_STATE_FILE = process.env["LEASH_HEARTBEAT_STATE_FILE"] ?? join(DATA_DIR, "leash-heartbeat-state.json");

/** Keep at most this many recent fingerprints; drop anything older than the TTL. */
const RECENT_KEEP = 50;
const RECENT_TTL_MS = 24 * 60 * 60 * 1000;

interface RecentItem {
  sig: string;
  text: string;
  ts: number;
}

interface HeartbeatState {
  /** Local "YYYY-MM-DD" → count of notifications surfaced that day (the per-day budget). */
  perDay?: Record<string, number>;
  /** Proposal signature → the user's pinned tier ("always do this"). Never lowers below the hard floor. */
  overrides?: Record<string, Tier>;
  /** Recently surfaced proposals, for dedup (exact via sig, fuzzy via text embeddings). */
  recent?: RecentItem[];
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => undefined);
  return run;
}

async function read(): Promise<HeartbeatState> {
  const s = await readJson<HeartbeatState>(HEARTBEAT_STATE_FILE, {});
  return s && typeof s === "object" ? s : {};
}

async function write(s: HeartbeatState): Promise<void> {
  await writeJson(HEARTBEAT_STATE_FILE, s);
  invalidateJsonCache(HEARTBEAT_STATE_FILE);
}

/** A coarse, stable signature for a proposal — lowercased alphanumeric words, first 8 joined.
 *  Used as both the dedup key and the "always do this" override key (same recurring nudge → same sig). */
export function signature(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 8).join(" ");
}

function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Count of notifications surfaced today. */
export async function countToday(now = Date.now()): Promise<number> {
  return (await read()).perDay?.[dayKey(now)] ?? 0;
}

/** True if today's count is still under `max` (max ≤ 0 ⇒ unlimited). */
export async function withinDailyBudget(max: number | undefined, now = Date.now()): Promise<boolean> {
  if (!max || max <= 0) return true;
  return (await countToday(now)) < max;
}

/** The user's pinned tier for a proposal signature, if any ("always do this"). */
export async function getOverride(text: string): Promise<Tier | undefined> {
  return (await read()).overrides?.[signature(text)];
}

/** Pin a tier for a proposal signature — future matching proposals use it (subject to the hard floor). */
export async function setOverride(text: string, tier: Tier): Promise<void> {
  await withLock(async () => {
    const s = await read();
    s.overrides ??= {};
    s.overrides[signature(text)] = tier;
    await write(s);
  });
}

/** Texts of non-expired recently-surfaced proposals (for fuzzy embedding dedup). */
export async function recentTexts(now = Date.now()): Promise<string[]> {
  const recent = (await read()).recent ?? [];
  return recent.filter((r) => now - r.ts < RECENT_TTL_MS).map((r) => r.text);
}

/** Has this exact-signature proposal been surfaced within the TTL? */
export async function seenRecently(text: string, now = Date.now()): Promise<boolean> {
  const sig = signature(text);
  return ((await read()).recent ?? []).some((r) => r.sig === sig && now - r.ts < RECENT_TTL_MS);
}

/** Record a surfaced proposal: bump today's budget count + append its fingerprint (pruned to window). */
export async function recordSurfaced(text: string, now = Date.now()): Promise<void> {
  await withLock(async () => {
    const s = await read();
    s.perDay ??= {};
    const k = dayKey(now);
    s.perDay[k] = (s.perDay[k] ?? 0) + 1;
    // Prune old day buckets (keep ~last 7) so the file doesn't grow forever.
    for (const day of Object.keys(s.perDay)) {
      if (day !== k && Object.keys(s.perDay).length > 7) delete s.perDay[day];
    }
    s.recent = [...(s.recent ?? []), { sig: signature(text), text: text.slice(0, 400), ts: now }]
      .filter((r) => now - r.ts < RECENT_TTL_MS)
      .slice(-RECENT_KEEP);
    await write(s);
  });
}
