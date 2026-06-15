/**
 * Schedule definitions (server-only) — backed by the mcp-cron scheduling engine.
 *
 * This module's PUBLIC API is unchanged from the leash-cron era (listSchedules /
 * createSchedule / updateSchedule / deleteSchedule / cronState / cronRuns + the same
 * types), so the dashboard, the schedules routes, and the tasks page don't change. What
 * changed is the BACKEND: instead of a hand-rolled `leash-schedule.json` + a polling
 * daemon, each schedule is an mcp-cron task (see cron-client.ts):
 *
 *   · the Leash ScheduleShape  → a 6-field cron expression (toCron)
 *   · the Leash kind+payload   → a shell command (buildCommand): a job runs `npm run …`,
 *                                a heartbeat runs leash-fire-heartbeat.mts (POSTs the
 *                                existing /api/leash/heartbeat), a task runs
 *                                leash-append-task.mts (appends to the task store)
 *   · the full ScheduleEntry   → JSON in the mcp-cron task's `description` field, so a
 *                                listing reconstructs the exact entry (single source of
 *                                truth — no sidecar file). The mcp-cron task `id` IS the
 *                                ScheduleEntry id; `enabled` is the mcp-cron task's flag.
 *
 * mcp-cron's run history (SQLite) replaces leash-cron-state.json / -runs.jsonl. All AI
 * stays in Leash on @qvac/sdk — `add_ai_task` is NEVER used (hard rule #1).
 */
import "server-only";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./json-store.ts";
import { cronList, cronGet, cronAdd, cronUpdate, cronRemove, cronResults, type CronTask } from "./cron-client.ts";

/** apps/web/lib/leash → monorepo root. The mcp-cron daemon runs from here (dev), but commands
 *  use absolute paths + `npm --prefix` so they don't depend on the daemon's cwd. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The legacy leash-cron schedule-definitions file. Schedules + run history now live in mcp-cron's
 * SQLite store; this path is referenced ONLY by the one-time migration in schedule-seed.ts, which
 * imports any pre-existing entries into mcp-cron and then renames the file to `.migrated`.
 */
export const SCHEDULE_FILE = process.env["LEASH_SCHEDULE_FILE"] ?? join(DATA_DIR, "leash-schedule.json");

/** Scripts the scheduler may spawn (root package.json scripts; extend deliberately).
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

/** Per-schedule state (lastRun/nextRun) — read from mcp-cron, display only. */
export interface CronScheduleState {
  lastRun?: number;
  lastOk?: boolean;
  nextRun?: number;
}

/** One run record (mapped from mcp-cron's SQLite result rows). */
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

// ── validation (unchanged contract) ────────────────────────────────────────────────

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
  if (entry.kind === "job" && entry.job?.script === "research" && !entry.job?.args?.[0]?.trim()) return false;
  if (entry.kind === "task" && !entry.task?.title?.trim()) return false;
  return true;
}

// ── ScheduleShape ↔ cron expression (6-field, seconds-first — robfig/cron/v3) ──────

function pad(n: number): string {
  return String(n);
}

function toCron(shape: ScheduleShape): string {
  switch (shape.type) {
    case "interval": {
      const m = Math.max(1, Math.floor(shape.minutes));
      if (m < 60) return `0 */${m} * * * *`; // every m minutes at :00s
      const h = Math.max(1, Math.floor(m / 60));
      return `0 0 */${h} * * *`; // ≥60min → hour granularity (the minute offset is dropped)
    }
    case "daily": {
      const [hh, mm] = shape.at.split(":").map(Number);
      return `0 ${pad(mm ?? 0)} ${pad(hh ?? 0)} * * *`;
    }
    case "weekly": {
      const [hh, mm] = shape.at.split(":").map(Number);
      return `0 ${pad(mm ?? 0)} ${pad(hh ?? 0)} * * ${shape.day}`;
    }
    case "once": {
      // mcp-cron has no one-shot; encode the exact minute. Spent `once` entries are reaped
      // (disabled) in listSchedules once they've fired, so the annual re-fire never happens.
      const d = new Date(shape.at);
      return `0 ${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    }
  }
}

// ── kind+payload → shell command ───────────────────────────────────────────────────

/** Single-quote a shell argument (POSIX): wrap in '…' and escape embedded quotes. */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

const HEARTBEAT_SCRIPT = join(REPO_ROOT, "apps", "web", "scripts", "leash-fire-heartbeat.mts");
const APPEND_TASK_SCRIPT = join(REPO_ROOT, "apps", "web", "scripts", "leash-append-task.mts");
const RESEARCH_SCRIPT = join(REPO_ROOT, "apps", "web", "scripts", "leash-research.mts");

function buildCommand(entry: Pick<ScheduleEntry, "kind" | "job" | "task" | "heartbeat" | "id">): string {
  if (entry.kind === "job") {
    const script = entry.job?.script as JobScript;
    if (script === "research") {
      // research takes a question + a run id. The command is static, so the run id is fixed per
      // schedule (recurring research re-uses it — acceptable for this rare case; ad-hoc research
      // is the common path). NOT an npm script.
      const rid = `cron-${entry.id}`;
      return `npx tsx ${q(RESEARCH_SCRIPT)} ${q(rid)} ${q(entry.job?.args?.[0]?.slice(0, 500) ?? "")}`;
    }
    // `npm --prefix <root>` so it doesn't depend on the daemon's cwd.
    return `npm --prefix ${q(REPO_ROOT)} run ${script}`;
  }
  if (entry.kind === "heartbeat") {
    const max = entry.heartbeat?.maxPerDay != null ? String(entry.heartbeat.maxPerDay) : "-";
    const start = entry.heartbeat?.activeHours?.start ?? "-";
    const end = entry.heartbeat?.activeHours?.end ?? "-";
    return `npx tsx ${q(HEARTBEAT_SCRIPT)} ${q(max)} ${q(start)} ${q(end)}`;
  }
  // task
  const t = entry.task;
  return `npx tsx ${q(APPEND_TASK_SCRIPT)} ${q(t?.title ?? "")} ${q(t?.detail ?? "")} ${q(t?.priority ?? "")} ${q((t?.tags ?? []).join(","))}`;
}

// ── ScheduleEntry ↔ mcp-cron task `description` (the metadata channel) ──────────────

interface Meta {
  v: 1;
  kind: ScheduleEntry["kind"];
  name: string;
  shape: ScheduleShape;
  job?: ScheduleEntry["job"];
  task?: ScheduleEntry["task"];
  heartbeat?: HeartbeatConfig;
  createdAt: number;
  updatedAt: number;
}

function encodeMeta(entry: ScheduleEntry): string {
  const m: Meta = {
    v: 1,
    kind: entry.kind,
    name: entry.name,
    shape: entry.schedule,
    ...(entry.job ? { job: entry.job } : {}),
    ...(entry.task ? { task: entry.task } : {}),
    ...(entry.heartbeat ? { heartbeat: entry.heartbeat } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  return JSON.stringify(m);
}

/** Reconstruct a ScheduleEntry from an mcp-cron task. Returns null for foreign (non-Leash) tasks. */
function toEntry(t: CronTask): ScheduleEntry | null {
  if (!t.description) return null;
  let m: Meta;
  try {
    m = JSON.parse(t.description) as Meta;
  } catch {
    return null;
  }
  if (!m || m.v !== 1 || !m.shape || !m.kind) return null;
  const entry: ScheduleEntry = {
    id: t.id,
    name: m.name || t.name,
    enabled: t.enabled,
    kind: m.kind,
    schedule: m.shape,
    ...(m.job ? { job: m.job } : {}),
    ...(m.task ? { task: m.task } : {}),
    ...(m.heartbeat ? { heartbeat: m.heartbeat } : {}),
    createdAt: m.createdAt ?? 0,
    updatedAt: m.updatedAt ?? 0,
  };
  return valid(entry) ? entry : null;
}

// ── public API (unchanged shapes) ───────────────────────────────────────────────────

/** Seed the defaults once per process (idempotent, seed-if-absent). Dynamic import breaks the
 *  schedule-seed ↔ schedules-store cycle and keeps it off the module-eval path. */
let seededOnce = false;
async function ensureSeeded(): Promise<void> {
  if (seededOnce) return;
  seededOnce = true;
  try {
    const { seedDefaultSchedules } = await import("./schedule-seed.ts");
    await seedDefaultSchedules();
  } catch {
    seededOnce = false; // a failed seed (daemon still warming) should retry next call
  }
}

/** All schedule definitions (reconstructed from mcp-cron). Reaps spent `once` entries. */
export async function listSchedules(): Promise<ScheduleEntry[]> {
  await ensureSeeded();
  const tasks = await cronList();
  const out: ScheduleEntry[] = [];
  for (const t of tasks) {
    const entry = toEntry(t);
    if (!entry) continue;
    // Reap a spent one-shot: a `once` schedule that has fired (status set) gets disabled, so it
    // never re-fires on the annual cron recurrence and the UI shows it as done.
    if (entry.schedule.type === "once" && entry.enabled && t.lastStatus !== undefined) {
      await cronUpdate(t.id, { enabled: false }).catch(() => {});
      entry.enabled = false;
    }
    out.push(entry);
  }
  return out;
}

/** Create a schedule entry. */
export async function createSchedule(input: Omit<ScheduleEntry, "id" | "createdAt" | "updatedAt">): Promise<ScheduleEntry | null> {
  const now = Date.now();
  // a provisional entry (id filled by mcp-cron) for validation + command/meta building
  const provisional: ScheduleEntry = { ...input, id: "pending", createdAt: now, updatedAt: now };
  if (!valid(provisional)) return null;
  const added = await cronAdd({
    name: input.name,
    schedule: toCron(input.schedule),
    command: buildCommand(provisional),
    enabled: input.enabled,
    description: encodeMeta(provisional),
  });
  if (!added) return null;
  // The command for `research` bakes the id; re-write it now that we have the real id, and
  // stamp the meta with the real id is unnecessary (meta has no id — id IS the task id).
  if (input.kind === "job" && input.job?.script === "research") {
    const cmd = buildCommand({ ...provisional, id: added.id });
    if (cmd !== added.command) await cronUpdate(added.id, { command: cmd }).catch(() => {});
  }
  return toEntry(added) ?? { ...provisional, id: added.id, enabled: added.enabled };
}

/** Patch a schedule entry (returns null if unknown/invalid). */
export async function updateSchedule(id: string, patch: Partial<Omit<ScheduleEntry, "id" | "createdAt">>): Promise<ScheduleEntry | null> {
  const current = await cronGet(id);
  const existing = current ? toEntry(current) : null;
  if (!existing) return null;
  const next: ScheduleEntry = { ...existing, ...patch, id, updatedAt: Date.now() };
  if (!valid(next)) return null;
  const updated = await cronUpdate(id, {
    name: next.name,
    schedule: toCron(next.schedule),
    command: buildCommand(next),
    description: encodeMeta(next),
    enabled: next.enabled,
  });
  return updated ? (toEntry(updated) ?? next) : null;
}

/** Delete a schedule entry. */
export async function deleteSchedule(id: string): Promise<boolean> {
  return cronRemove(id);
}

/** Per-schedule state (lastRun/nextRun) from mcp-cron — display only. */
export async function cronState(): Promise<Record<string, CronScheduleState>> {
  const tasks = await cronList();
  const out: Record<string, CronScheduleState> = {};
  for (const t of tasks) {
    if (!t.description) continue; // only Leash-managed tasks
    const st: CronScheduleState = {};
    if (t.nextRun !== undefined) st.nextRun = t.nextRun;
    // mcp-cron stamps lastRun on add; only treat it as a real run once a status exists.
    if (t.lastStatus !== undefined) {
      if (t.lastRun !== undefined) st.lastRun = t.lastRun;
      st.lastOk = t.lastStatus === "ok";
    }
    out[t.id] = st;
  }
  return out;
}

/** Recent runs across all schedules, newest first (mapped from mcp-cron's SQLite history). */
export async function cronRuns(limit = 30): Promise<CronRun[]> {
  const tasks = (await cronList()).filter((t) => t.description); // Leash-managed only
  const perTask = await Promise.all(
    tasks.map(async (t) => {
      const meta = toEntry(t);
      const rows = await cronResults(t.id, limit);
      return rows.map(
        (r): CronRun => ({
          id: `${t.id}-${r.finishedAt}`,
          scheduleId: t.id,
          name: meta?.name ?? t.name,
          kind: meta?.kind ?? "job",
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          ok: r.ok,
          ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
          ...(r.output ? { outputTail: r.output.slice(0, 1500) } : {}),
          ...(r.error ? { error: r.error } : {}),
        }),
      );
    }),
  );
  return perTask
    .flat()
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, limit);
}
