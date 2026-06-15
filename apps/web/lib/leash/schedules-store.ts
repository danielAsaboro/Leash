/**
 * Schedule definitions (server-only) — `data/leash-schedule.json`, WEB-OWNED.
 *
 * The cron daemon (`apps/leash-cron`) only READS this file; it writes its own
 * `leash-cron-state.json` (lastRun/nextRun per schedule) and appends run records to
 * `leash-cron-runs.jsonl`. Split ownership = no cross-process write contention.
 * Timing logic (next-run computation) lives in the DAEMON — the dashboard displays
 * the daemon's own numbers instead of re-deriving them.
 *
 * A schedule fires either a JOB (allowlisted npm script, spawned detached by the
 * daemon) or a TASK (a row appended to the shared task store) — per the house
 * taxonomy: services produce tasks.
 */
import "server-only";
import { generateId } from "ai";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readJson, readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";

export const SCHEDULE_FILE = process.env["LEASH_SCHEDULE_FILE"] ?? join(DATA_DIR, "leash-schedule.json");
export const CRON_STATE_FILE = process.env["LEASH_CRON_STATE_FILE"] ?? join(DATA_DIR, "leash-cron-state.json");
export const CRON_RUNS_FILE = process.env["LEASH_CRON_RUNS_FILE"] ?? join(DATA_DIR, "leash-cron-runs.jsonl");

/** Scripts the cron daemon may spawn (root package.json scripts; extend deliberately).
 *  `research` is special: it takes a question via `job.args[0]` and spawns the research
 *  child rather than an npm script. */
export const JOB_ALLOWLIST = ["dream", "tag-photos", "research", "evolve"] as const;
export type JobScript = (typeof JOB_ALLOWLIST)[number];

export type ScheduleShape =
  | { type: "once"; at: string } // ISO datetime
  | { type: "interval"; minutes: number }
  | { type: "daily"; at: string } // "HH:MM" local
  | { type: "weekly"; day: number; at: string }; // day 0=Sun … 6=Sat

/** Tuning for a `heartbeat` schedule — the autonomous proactive turn (see /api/leash/heartbeat). */
export interface HeartbeatConfig {
  /** Local active-hours window "HH:MM"–"HH:MM"; outside it the heartbeat stays silent. */
  activeHours?: { start: string; end: string };
  /** Per-day notification budget — the loop stops surfacing once this many fire today. */
  maxPerDay?: number;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  kind: "job" | "task" | "heartbeat";
  schedule: ScheduleShape;
  job?: { script: JobScript; args?: string[] };
  task?: { title: string; detail?: string; priority?: "low" | "normal" | "high"; tags?: string[] };
  /** Present for `kind: "heartbeat"` — drives the autonomous proactive loop. */
  heartbeat?: HeartbeatConfig;
  createdAt: number;
  updatedAt: number;
}

/** Cron-owned per-schedule state (read-only here). */
export interface CronScheduleState {
  lastRun?: number;
  lastOk?: boolean;
  nextRun?: number;
}

/** One run record from leash-cron-runs.jsonl (read-only here). */
export interface CronRun {
  id: string;
  scheduleId: string;
  name: string;
  kind: "job" | "task" | "heartbeat";
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  exitCode?: number;
  outputTail?: string;
  error?: string;
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => undefined);
  return run;
}

function valid(entry: Partial<ScheduleEntry>): entry is ScheduleEntry {
  if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") return false;
  if (entry.kind !== "job" && entry.kind !== "task" && entry.kind !== "heartbeat") return false;
  const s = entry.schedule as ScheduleShape | undefined;
  if (!s) return false;
  if (s.type === "once" && !s.at) return false;
  if (s.type === "interval" && !(s.minutes >= 1)) return false;
  if (s.type === "daily" && !/^\d{2}:\d{2}$/.test(s.at)) return false;
  if (s.type === "weekly" && (!/^\d{2}:\d{2}$/.test(s.at) || !(s.day >= 0 && s.day <= 6))) return false;
  if (entry.kind === "job" && !JOB_ALLOWLIST.includes(entry.job?.script as JobScript)) return false;
  if (entry.kind === "job" && entry.job?.script === "research" && !entry.job?.args?.[0]?.trim()) return false; // research needs a question
  if (entry.kind === "task" && !entry.task?.title?.trim()) return false;
  // heartbeat entries carry no job/task payload — the schedule shape (interval/daily) is enough.
  return true;
}

/** All schedule definitions (mtime-cached; seeded on first load — see below). */
export async function listSchedules(): Promise<ScheduleEntry[]> {
  const raw = await readJsonCached<unknown>(SCHEDULE_FILE, null);
  if (raw === null) {
    // First load: seed the REAL nightly jobs — dream (consolidate chats) then evolve
    // (the Layer-4 LoRA loop). Both daily at 03:30; cron serializes jobs, so they run
    // back-to-back while the GPU is idle (it never kills a mid-generation worker).
    const now = Date.now();
    const seeds: ScheduleEntry[] = [
      {
        id: generateId(),
        name: "Dream — consolidate chats into tasks",
        enabled: true,
        kind: "job",
        schedule: { type: "daily", at: "03:30" },
        job: { script: "dream" },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId(),
        name: "Evolve — nightly on-device LoRA (better at you)",
        enabled: true,
        kind: "job",
        schedule: { type: "daily", at: "03:30" },
        job: { script: "evolve" },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: generateId(),
        name: "Heartbeat — proactive check against your goals",
        enabled: true,
        kind: "heartbeat",
        schedule: { type: "interval", minutes: 30 },
        heartbeat: { activeHours: { start: "09:00", end: "22:00" }, maxPerDay: 12 },
        createdAt: now,
        updatedAt: now,
      },
    ];
    await writeJson(SCHEDULE_FILE, seeds);
    invalidateJsonCache(SCHEDULE_FILE);
    return seeds;
  }
  return Array.isArray(raw) ? (raw as Partial<ScheduleEntry>[]).filter(valid) : [];
}

/** Create a schedule entry. */
export async function createSchedule(input: Omit<ScheduleEntry, "id" | "createdAt" | "updatedAt">): Promise<ScheduleEntry | null> {
  const entry: ScheduleEntry = { ...input, id: generateId(), createdAt: Date.now(), updatedAt: Date.now() };
  if (!valid(entry)) return null;
  return withLock(async () => {
    const all = await listSchedules();
    await writeJson(SCHEDULE_FILE, [...all, entry]);
    invalidateJsonCache(SCHEDULE_FILE);
    return entry;
  });
}

/** Patch a schedule entry (returns null if unknown/invalid). */
export async function updateSchedule(id: string, patch: Partial<Omit<ScheduleEntry, "id" | "createdAt">>): Promise<ScheduleEntry | null> {
  return withLock(async () => {
    const all = await listSchedules();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const next = { ...(all[idx] as ScheduleEntry), ...patch, id, updatedAt: Date.now() };
    if (!valid(next)) return null;
    all[idx] = next;
    await writeJson(SCHEDULE_FILE, all);
    invalidateJsonCache(SCHEDULE_FILE);
    return next;
  });
}

/** Delete a schedule entry. */
export async function deleteSchedule(id: string): Promise<boolean> {
  return withLock(async () => {
    const all = await listSchedules();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    await writeJson(SCHEDULE_FILE, next);
    invalidateJsonCache(SCHEDULE_FILE);
    return true;
  });
}

/** The daemon's per-schedule state (lastRun/nextRun) — display only. */
export async function cronState(): Promise<Record<string, CronScheduleState>> {
  const raw = await readJson<Record<string, CronScheduleState>>(CRON_STATE_FILE, {});
  return raw && typeof raw === "object" ? raw : {};
}

/** Recent cron runs, newest first (lenient JSONL read). */
export async function cronRuns(limit = 30): Promise<CronRun[]> {
  let raw: string;
  try {
    raw = await readFile(CRON_RUNS_FILE, "utf8");
  } catch {
    return [];
  }
  const out: CronRun[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as CronRun);
    } catch {
      /* torn line */
    }
  }
  return out.reverse().slice(0, limit);
}
