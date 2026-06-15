/**
 * Scheduler tool group — lets the assistant schedule its OWN future actions.
 *
 * This is the curated, safe subset of "scheduling as tools": the agent can schedule the SAME
 * vetted actions the dashboard offers — an allowlisted maintenance job, or a recurring
 * reminder (a task) — and list/enable/disable/remove its schedules. It can NOT run arbitrary
 * shell, and there is deliberately NO AI-task tool: mcp-cron's cloud-default `add_ai_task` is
 * never exposed (hard rule #1 — all inference stays in Leash on @qvac/sdk). A load-time
 * assertion (below) enforces that no tool here is AI/shell/exec-shaped.
 *
 * The handlers are a thin client over the web's existing schedules API
 * (`/api/leash/schedules`, dual-authorized by the shared internal token) — the SAME
 * createSchedule/updateSchedule path the dashboard uses, so a schedule the agent makes shows
 * up in the dashboard and fires through mcp-cron identically. No scheduling logic is
 * duplicated here. Default-OFF in Brain → MCP (opt-in — it lets the agent create recurring work).
 */
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolGroup, type GroupTool } from "./types.ts";
import type { LeashSource } from "../sources.ts";

const NO_SOURCES: LeashSource[] = [];

/** The maintenance jobs the agent may schedule — mirror of schedules-store's JOB_ALLOWLIST. */
const JOB_SCRIPTS = ["dream", "tag-photos", "research", "evolve"] as const;

function webBase(): string {
  return process.env["LEASH_WEB_BASE"] ?? `http://127.0.0.1:${process.env["LEASH_WEB_PORT"] ?? process.env["PORT"] ?? "6801"}`;
}

/** Shared internal token: env first (inherited from the scope), token-file fallback. */
function internalToken(): string {
  const fromEnv = process.env["LEASH_INTERNAL_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  const dir = process.env["LEASH_DATA_DIR"];
  if (!dir) return "";
  try {
    return readFileSync(join(dir, ".leash-internal-token"), "utf8").trim();
  } catch {
    return "";
  }
}

interface ApiOut {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
}
async function api(path: string, init?: RequestInit): Promise<ApiOut> {
  const tok = internalToken();
  const r = await fetch(`${webBase()}/api/leash/schedules${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-leash-internal": tok, ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { ok: r.ok, status: r.status, json, text };
}

// ── recurrence: a flat, model-friendly schedule input → the store's ScheduleShape ──

const recurrenceShape = {
  recurrence: z.enum(["daily", "weekly", "interval", "once"]).describe("How often: 'daily' at a time, 'weekly' on a day+time, 'interval' every N minutes, or 'once' at a datetime."),
  at: z.string().optional().describe("Local time 'HH:MM' (required for daily/weekly)."),
  dayOfWeek: z.number().int().min(0).max(6).optional().describe("Day for weekly: 0=Sun … 6=Sat."),
  everyMinutes: z.number().int().min(1).optional().describe("Minutes between runs (required for interval)."),
  onceAt: z.string().optional().describe("ISO datetime for a one-time run (required for once)."),
};

type Recurrence = { recurrence: "daily" | "weekly" | "interval" | "once"; at?: string; dayOfWeek?: number; everyMinutes?: number; onceAt?: string };
type ScheduleShape =
  | { type: "once"; at: string }
  | { type: "interval"; minutes: number }
  | { type: "daily"; at: string }
  | { type: "weekly"; day: number; at: string };

/** Build a ScheduleShape from the flat recurrence fields, or an error string. */
function buildShape(a: Recurrence): { shape: ScheduleShape } | { error: string } {
  const hhmm = /^\d{2}:\d{2}$/;
  switch (a.recurrence) {
    case "daily":
      if (!a.at || !hhmm.test(a.at)) return { error: "daily needs `at` as 'HH:MM'." };
      return { shape: { type: "daily", at: a.at } };
    case "weekly":
      if (!a.at || !hhmm.test(a.at)) return { error: "weekly needs `at` as 'HH:MM'." };
      if (a.dayOfWeek === undefined) return { error: "weekly needs `dayOfWeek` (0=Sun … 6=Sat)." };
      return { shape: { type: "weekly", day: a.dayOfWeek, at: a.at } };
    case "interval":
      if (!a.everyMinutes || a.everyMinutes < 1) return { error: "interval needs `everyMinutes` ≥ 1." };
      return { shape: { type: "interval", minutes: a.everyMinutes } };
    case "once":
      if (!a.onceAt || !Number.isFinite(Date.parse(a.onceAt))) return { error: "once needs `onceAt` as an ISO datetime." };
      return { shape: { type: "once", at: a.onceAt } };
  }
}

function describeShape(s: ScheduleShape): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (s.type) {
    case "daily": return `daily at ${s.at}`;
    case "weekly": return `every ${days[s.day]} at ${s.at}`;
    case "interval": return `every ${s.minutes} min`;
    case "once": return `once at ${new Date(s.at).toLocaleString()}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createVia(body: Record<string, unknown>): Promise<{ text: string }> {
  const r = await api("", { method: "POST", body: JSON.stringify(body) });
  if (r.status === 403) return { text: "Couldn't schedule: the scheduler isn't authorized (internal token missing). Is the app running normally?" };
  if (!r.ok || !r.json?.schedule) return { text: `Couldn't schedule: ${r.json?.error ?? r.text.slice(0, 200)}` };
  const e = r.json.schedule;
  return { text: `Scheduled "${e.name}" — ${describeShape(e.schedule)} (id ${e.id}). It will run on its schedule; manage it from the Brain → Services schedules list.` };
}

export const schedulerGroup: ToolGroup = {
  id: "scheduler",
  label: "Scheduler",
  description: "Let the assistant schedule its own future actions: recurring reminders (tasks) and allowlisted maintenance jobs. No arbitrary commands, no cloud AI tasks.",
  tools: [
    defineTool({
      name: "list_schedules",
      description: "List the user's current schedules (recurring jobs, reminders, and the proactive heartbeat), with their cadence and last/next run. Use before enabling/disabling/removing to find a schedule's id.",
      inputSchema: {},
      handler: async () => {
        const r = await api("", { method: "GET" });
        if (!r.ok || !Array.isArray(r.json?.schedules)) return { text: `Couldn't read schedules: ${r.json?.error ?? r.text.slice(0, 160)}`, sources: NO_SOURCES };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = r.json.state ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lines = r.json.schedules.map((e: any) => {
          const st = state[e.id] ?? {};
          const what = e.kind === "job" ? `job: ${e.job?.script}` : e.kind === "heartbeat" ? "proactive heartbeat" : `reminder: "${e.task?.title}"`;
          const next = st.nextRun ? ` · next ${new Date(st.nextRun).toLocaleString()}` : "";
          return `• ${e.name} — ${what} · ${describeShape(e.schedule)}${e.enabled ? "" : " (disabled)"}${next} [id ${e.id}]`;
        });
        return { text: lines.length ? lines.join("\n") : "No schedules yet.", sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "schedule_reminder",
      description: "Schedule a recurring (or one-time) REMINDER — it adds a task to the user's to-do list on the given cadence. Use when the user asks to be reminded of something regularly (e.g. 'every weekday at 9am remind me to review my goals').",
      inputSchema: {
        title: z.string().describe("Short, actionable reminder/task title."),
        detail: z.string().optional().describe("Optional context for the task."),
        priority: z.enum(["low", "normal", "high"]).optional().describe("Task priority (default normal)."),
        name: z.string().optional().describe("Optional name for the schedule itself (defaults to the title)."),
        ...recurrenceShape,
      },
      handler: async (a) => {
        const built = buildShape(a as Recurrence);
        if ("error" in built) return { text: built.error, sources: NO_SOURCES };
        const out = await createVia({
          name: (a.name as string)?.trim() || (a.title as string),
          enabled: true,
          kind: "task",
          schedule: built.shape,
          task: { title: a.title, ...(a.detail ? { detail: a.detail } : {}), ...(a.priority ? { priority: a.priority } : {}) },
        });
        return { ...out, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "schedule_job",
      description: "Schedule an allowlisted on-device maintenance JOB on a cadence. Jobs: 'dream' (consolidate chats into tasks), 'evolve' (nightly on-device LoRA), 'tag-photos' (auto-tag images), 'research' (a background web research run — needs a question). No other commands can be scheduled.",
      inputSchema: {
        script: z.enum(JOB_SCRIPTS).describe("Which allowlisted job to run."),
        question: z.string().optional().describe("Required only for 'research': the question to research each run."),
        name: z.string().optional().describe("Optional name for the schedule (defaults to 'Run <script>')."),
        ...recurrenceShape,
      },
      handler: async (a) => {
        const built = buildShape(a as Recurrence);
        if ("error" in built) return { text: built.error, sources: NO_SOURCES };
        if (a.script === "research" && !(a.question as string)?.trim()) return { text: "The 'research' job needs a `question`.", sources: NO_SOURCES };
        const out = await createVia({
          name: (a.name as string)?.trim() || `Run ${a.script}`,
          enabled: true,
          kind: "job",
          schedule: built.shape,
          job: { script: a.script, ...(a.script === "research" ? { args: [(a.question as string).trim()] } : {}) },
        });
        return { ...out, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "enable_schedule",
      description: "Enable (resume) a schedule by its id so it runs on its cadence again.",
      inputSchema: { id: z.string().describe("The schedule id (from list_schedules).") },
      handler: async (a) => {
        const r = await api(`/${encodeURIComponent(a.id as string)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
        return { text: r.ok ? `Enabled "${r.json?.schedule?.name ?? a.id}".` : `Couldn't enable: ${r.json?.error ?? r.text.slice(0, 160)}`, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "disable_schedule",
      description: "Disable (pause) a schedule by its id so it stops running, without deleting it.",
      inputSchema: { id: z.string().describe("The schedule id (from list_schedules).") },
      handler: async (a) => {
        const r = await api(`/${encodeURIComponent(a.id as string)}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
        return { text: r.ok ? `Disabled "${r.json?.schedule?.name ?? a.id}".` : `Couldn't disable: ${r.json?.error ?? r.text.slice(0, 160)}`, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "remove_schedule",
      description: "Permanently delete a schedule by its id.",
      inputSchema: { id: z.string().describe("The schedule id (from list_schedules).") },
      handler: async (a) => {
        const r = await api(`/${encodeURIComponent(a.id as string)}`, { method: "DELETE" });
        return { text: r.ok ? `Removed schedule ${a.id}.` : `Couldn't remove: ${r.json?.error ?? r.text.slice(0, 160)}`, sources: NO_SOURCES };
      },
    }),
  ],
};

// ── hard-rule guard (load-time): no AI-task / raw-shell / exec tool may EVER live here. ──
const FORBIDDEN_TOOL = /(^|_)ai(_|$)|shell|exec|command|eval|spawn|prompt/i;
for (const t of schedulerGroup.tools as GroupTool[]) {
  if (FORBIDDEN_TOOL.test(t.name)) {
    throw new Error(`scheduler group: tool "${t.name}" is forbidden — the agent must never schedule AI tasks or arbitrary commands (hard rule #1).`);
  }
}
