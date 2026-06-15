/**
 * leash-cron — the scheduler daemon.
 *
 *   npm run cron          (from repo root; or started from the /services console)
 *
 * Every 30s tick: read schedule DEFINITIONS from `data/leash-schedule.json`
 * (web-owned — the dashboard edits it; we only read), fire anything due, then write
 * OUR files: `leash-cron-state.json` (lastRun/nextRun per schedule),
 * `leash-cron-runs.jsonl` (append-only run records), and a heartbeat the /services
 * card watches. Split file ownership = no cross-process write contention.
 *
 * A schedule fires either a JOB — an allowlisted npm script spawned with output
 * capture — or a TASK — a row appended to the shared task store (read+merge+atomic
 * write, the dream.mts discipline; the web tolerates concurrent task writers).
 * Jobs that need the model serve fail honestly into the run log when it's down;
 * cron never auto-starts other services.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/leash-cron/src → repo root. */
const ROOT = join(here, "..", "..", "..");
const DATA = join(ROOT, "data");

const SCHEDULE_FILE = process.env["LEASH_SCHEDULE_FILE"] ?? join(DATA, "leash-schedule.json");
const STATE_FILE = process.env["LEASH_CRON_STATE_FILE"] ?? join(DATA, "leash-cron-state.json");
const RUNS_FILE = process.env["LEASH_CRON_RUNS_FILE"] ?? join(DATA, "leash-cron-runs.jsonl");
const TASKS_FILE = process.env["LEASH_TASKS_FILE"] ?? join(DATA, "leash-tasks.json");
const HEARTBEAT = process.env["LEASH_CRON_HEARTBEAT"] ?? join(DATA, "leash-services", "leash-cron.heartbeat");
/** Shared internal token for server-to-server POSTs to the web (resolved from the SAME data dir as
 *  the schedule file, which the web also writes to — so cron and web always read the same secret). */
const TOKEN_FILE = process.env["LEASH_INTERNAL_TOKEN_FILE"] ?? join(dirname(SCHEDULE_FILE), ".leash-internal-token");
/** Where the web app listens (localhost). Heartbeat schedules POST here. */
const WEB_BASE = process.env["LEASH_WEB_BASE"] ?? `http://127.0.0.1:${process.env["LEASH_WEB_PORT"] ?? process.env["PORT"] ?? "6801"}`;

const TICK_MS = 30_000;
/** Scripts we may spawn — mirror of the web's JOB_ALLOWLIST (schedules-store.ts). */
const JOB_ALLOWLIST = new Set(["dream", "tag-photos", "research", "evolve"]);
const RESEARCH_SCRIPT = join(ROOT, "apps", "web", "scripts", "leash-research.mts");
/** A job may run this long before we stop waiting (we never kill it — soft timeout). */
const JOB_WAIT_MS = 15 * 60 * 1000;

// ── Shapes (mirrors apps/web lib/leash/schedules-store.ts — kept in sync by hand,
//    the dream.mts convention for cross-process file contracts) ──────────────────

type ScheduleShape =
  | { type: "once"; at: string }
  | { type: "interval"; minutes: number }
  | { type: "daily"; at: string }
  | { type: "weekly"; day: number; at: string };

interface ScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  kind: "job" | "task" | "heartbeat";
  schedule: ScheduleShape;
  job?: { script: string; args?: string[] };
  task?: { title: string; detail?: string; priority?: string; tags?: string[] };
  heartbeat?: { activeHours?: { start: string; end: string }; maxPerDay?: number };
}

interface ScheduleState {
  lastRun?: number;
  lastOk?: boolean;
  nextRun?: number;
}

interface TaskRow {
  id: string;
  title: string;
  detail?: string;
  status: string;
  priority: string;
  tags: string[];
  source: string;
  chatIds: string[];
  createdAt: number;
  updatedAt: number;
}

// ── Lenient file IO ──────────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** Definitions are reloaded only when the file changes (mtime-keyed). */
let schedulesCache: { mtimeMs: number; entries: ScheduleEntry[] } | null = null;
function loadSchedules(): ScheduleEntry[] {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(SCHEDULE_FILE).mtimeMs;
  } catch {
    return [];
  }
  if (schedulesCache && schedulesCache.mtimeMs === mtimeMs) return schedulesCache.entries;
  const raw = readJson<unknown>(SCHEDULE_FILE, []);
  const entries = (Array.isArray(raw) ? raw : []).filter(
    (e): e is ScheduleEntry => !!e && typeof (e as ScheduleEntry).id === "string" && !!(e as ScheduleEntry).schedule,
  );
  schedulesCache = { mtimeMs, entries };
  return entries;
}

// ── Next-run computation (the four shapes; local time) ──────────────────────────

/** The next due time STRICTLY AFTER `after`, or null for spent `once` entries. */
function nextRunAfter(shape: ScheduleShape, after: number): number | null {
  if (shape.type === "once") {
    const at = new Date(shape.at).getTime();
    return Number.isFinite(at) && at > after ? at : null;
  }
  if (shape.type === "interval") {
    return after + Math.max(1, shape.minutes) * 60_000;
  }
  const [hh, mm] = shape.at.split(":").map(Number);
  const d = new Date(after);
  d.setHours(hh ?? 0, mm ?? 0, 0, 0);
  if (shape.type === "daily") {
    while (d.getTime() <= after) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // weekly
  while (d.getDay() !== shape.day || d.getTime() <= after) d.setDate(d.getDate() + 1);
  d.setHours(hh ?? 0, mm ?? 0, 0, 0);
  return d.getTime();
}

// ── Firing ───────────────────────────────────────────────────────────────────────

const rid = (): string => `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function appendRun(run: Record<string, unknown>): void {
  mkdirSync(dirname(RUNS_FILE), { recursive: true });
  appendFileSync(RUNS_FILE, JSON.stringify(run) + "\n");
}

/** Fire a job: spawn the allowlisted npm script, capture an output tail. */
function fireJob(entry: ScheduleEntry): Promise<{ ok: boolean; exitCode?: number; outputTail?: string; error?: string }> {
  return new Promise((resolve) => {
    const script = entry.job?.script ?? "";
    if (!JOB_ALLOWLIST.has(script)) return resolve({ ok: false, error: `script "${script}" is not allowlisted` });
    // `research` spawns the research child directly (it takes a question + a run id);
    // it's fire-and-forget — the run continues in its own detached process, so the
    // schedule run record just notes it was launched. Everything else is `npm run`.
    if (script === "research") {
      const question = entry.job?.args?.[0]?.trim();
      if (!question) return resolve({ ok: false, error: "research job has no question (job.args[0])" });
      const id = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const child = spawn("npx", ["tsx", RESEARCH_SCRIPT, id, question.slice(0, 500)], { cwd: ROOT, detached: true, stdio: "ignore" });
      child.unref();
      return resolve({ ok: true, outputTail: `launched research run ${id} for "${question.slice(0, 60)}" → /research?run=${id}` });
    }
    const child = spawn("npm", ["run", script], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (chunk: Buffer): void => {
      out = (out + chunk.toString()).slice(-4000); // keep a rolling tail
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let settled = false;
    const settle = (r: { ok: boolean; exitCode?: number; outputTail?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Soft timeout: stop WAITING but never kill (the job may be mid-inference —
    // killing a generation against the serve is the house taboo).
    const timer = setTimeout(() => settle({ ok: false, error: `still running after ${JOB_WAIT_MS / 60000} min — stopped waiting (job not killed)`, outputTail: out.slice(-1500) }), JOB_WAIT_MS);
    child.on("error", (err) => settle({ ok: false, error: String(err) }));
    child.on("exit", (code) => settle({ ok: code === 0, exitCode: code ?? -1, outputTail: out.slice(-1500) }));
  });
}

/** Fire a task: append to the shared task store (read+merge+atomic write). */
function fireTask(entry: ScheduleEntry): { ok: boolean; error?: string } {
  const t = entry.task;
  if (!t?.title?.trim()) return { ok: false, error: "task entry has no title" };
  const raw = readJson<unknown>(TASKS_FILE, []);
  const tasks = Array.isArray(raw) ? (raw as TaskRow[]) : [];
  const now = Date.now();
  tasks.push({
    id: `cron-${now}-${Math.random().toString(36).slice(2, 6)}`,
    title: t.title.trim().slice(0, 120),
    ...(t.detail ? { detail: String(t.detail).slice(0, 1000) } : {}),
    status: "open",
    priority: t.priority === "low" || t.priority === "high" ? t.priority : "normal",
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string").slice(0, 8) : [],
    source: "cron",
    chatIds: [],
    createdAt: now,
    updatedAt: now,
  });
  writeJsonAtomic(TASKS_FILE, tasks);
  return { ok: true };
}

/** Read the shared internal token (server-to-server auth). Empty string until the web app seeds it. */
function internalToken(): string {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/** Is `now` within the local active-hours window? Inclusive start, exclusive end; tolerates a window
 *  that wraps midnight (start > end). A missing window means "always active". */
function withinActiveHours(hb: ScheduleEntry["heartbeat"], now: number): boolean {
  const w = hb?.activeHours;
  if (!w) return true;
  const mins = (s: string): number => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = mins(w.start);
  const end = mins(w.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Fire a heartbeat: POST to the web's autonomous heartbeat route and relay its verdict to the run log. */
async function fireHeartbeat(entry: ScheduleEntry): Promise<{ ok: boolean; outputTail?: string; error?: string }> {
  if (!withinActiveHours(entry.heartbeat, Date.now())) return { ok: true, outputTail: "outside active hours — skipped" };
  const tok = internalToken();
  if (!tok) return { ok: false, error: `no internal token at ${TOKEN_FILE} — is the web app running/seeded?` };
  try {
    const res = await fetch(`${WEB_BASE}/api/leash/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-leash-internal": tok },
      body: JSON.stringify({ maxPerDay: entry.heartbeat?.maxPerDay }),
    });
    if (!res.ok) return { ok: false, error: `web returned ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; suppressed?: boolean; proposal?: string | null; error?: string };
    if (body.error) return { ok: false, error: body.error };
    return { ok: true, outputTail: body.suppressed ? "HEARTBEAT_OK (silent)" : (body.proposal ?? "").slice(0, 1500) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── The tick ─────────────────────────────────────────────────────────────────────

/** Serializes job execution so two slow jobs never stack on the serve. */
let firing = false;

async function tick(): Promise<void> {
  mkdirSync(dirname(HEARTBEAT), { recursive: true });
  writeFileSync(HEARTBEAT, new Date().toISOString());

  const entries = loadSchedules();
  const state = readJson<Record<string, ScheduleState>>(STATE_FILE, {});
  const now = Date.now();
  let stateDirty = false;

  for (const entry of entries) {
    const st = (state[entry.id] ??= {});
    // First sighting: arm without firing (a freshly-created "daily 03:30" entry
    // shouldn't fire immediately at 15:00).
    if (st.nextRun === undefined) {
      const next = nextRunAfter(entry.schedule, now);
      if (next !== null) {
        st.nextRun = next;
        stateDirty = true;
        console.log(`⏰ armed "${entry.name}" → ${new Date(next).toLocaleString()}`);
      }
      continue;
    }
    if (!entry.enabled || st.nextRun === null || now < st.nextRun) continue;
    if (firing) continue; // a slow job is running — re-check next tick

    firing = true;
    const startedAt = Date.now();
    console.log(`▶ firing "${entry.name}" (${entry.kind})`);
    let result: { ok: boolean; exitCode?: number; outputTail?: string; error?: string };
    try {
      result = entry.kind === "job" ? await fireJob(entry) : entry.kind === "heartbeat" ? await fireHeartbeat(entry) : fireTask(entry);
    } catch (err) {
      result = { ok: false, error: String(err) };
    }
    firing = false;
    const finishedAt = Date.now();
    appendRun({ id: rid(), scheduleId: entry.id, name: entry.name, kind: entry.kind, startedAt, finishedAt, ...result });
    console.log(`${result.ok ? "✓" : "✗"} "${entry.name}" in ${((finishedAt - startedAt) / 1000).toFixed(1)}s${result.error ? ` — ${result.error}` : ""}`);

    st.lastRun = startedAt;
    st.lastOk = result.ok;
    const next = nextRunAfter(entry.schedule, finishedAt);
    st.nextRun = next ?? undefined;
    if (next === null) console.log(`  (once-entry spent — it stays disabled in effect)`);
    stateDirty = true;
  }

  // Drop state for deleted schedules so the file doesn't grow forever.
  for (const id of Object.keys(state)) {
    if (!entries.some((e) => e.id === id)) {
      delete state[id];
      stateDirty = true;
    }
  }
  if (stateDirty) writeJsonAtomic(STATE_FILE, state);
}

console.log(`⏰ leash-cron up — tick every ${TICK_MS / 1000}s, schedule: ${SCHEDULE_FILE}`);
await tick();
const interval = setInterval(() => void tick().catch((err) => console.error("tick failed:", err)), TICK_MS);

const quit = (): void => {
  clearInterval(interval);
  console.log("⏰ leash-cron down");
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
