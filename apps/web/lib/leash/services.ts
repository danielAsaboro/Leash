/**
 * Service supervision (server-only) — the generic layer behind the /services console.
 *
 * Taxonomy (the house definitions): a SERVICE is the managed system around a DAEMON
 * (a long-running background process); daemons produce TASKS (units of work that run,
 * finish, exit). This module supervises the daemons:
 *
 *   · watcher     — `npm run watch` (screen observations → leash-activity.jsonl)
 *   · newsroom    — `npm run newsroom` (the paper's pipeline daemon)
 *   · leash-cron  — `npx tsx apps/leash-cron/src/main.ts` (the scheduler)
 *   · qvac-serve  — supervised by `serve-control.ts` (port-probe health + the
 *                   inflight GPU guard); aggregated into the same status list here
 *
 * Same discipline as serve-control: detached spawn + unref, stdio → a log FILE (never
 * a pty — an orphaned pty fills and blocks the child), pidfile under
 * `data/leash-services/`, stateless rediscovery. Externally-started daemons are
 * DETECTED via their freshness signal and shown honestly as "external" — Stop only
 * works on pids we recorded.
 */
import "server-only";
import { spawn } from "node:child_process";
import { openSync, closeSync, statSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson, DATA_DIR } from "./json-store.ts";
import { ACTIVITY_LOG } from "./graph.ts";
import { prisma } from "../db.ts";
import { serveStatus, startServe, stopServe } from "./serve-control.ts";

const ROOT = join(DATA_DIR, "..");
export const SERVICES_DIR = process.env["LEASH_SERVICES_DIR"] ?? join(DATA_DIR, "leash-services");
/** Touched by leash-cron every tick. */
export const CRON_HEARTBEAT = join(SERVICES_DIR, "leash-cron.heartbeat");

export type ServiceName = "qvac-serve" | "watcher" | "newsroom" | "leash-cron" | "leash-broker";

/** Where the broker listens (probe target for its health). */
const BROKER_PORT = Number(process.env["LEASH_BROKER_PORT"] ?? 11436);

interface ServiceDef {
  name: Exclude<ServiceName, "qvac-serve">;
  label: string;
  command: string[];
  /** What the daemon is for (shown on the card). */
  blurb: string;
  /** Freshness: true=signal fresh, false=signal stale, null=no signal yet. */
  freshness: () => Promise<{ fresh: boolean | null; detail: string }>;
}

function mtimeWithin(file: string, ms: number): { fresh: boolean | null; ageMs: number | null } {
  try {
    const age = Date.now() - statSync(file).mtimeMs;
    return { fresh: age < ms, ageMs: age };
  } catch {
    return { fresh: null, ageMs: null };
  }
}

const ago = (ms: number | null): string => {
  if (ms === null) return "never";
  const m = Math.floor(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
};

const DEFS: ServiceDef[] = [
  {
    name: "watcher",
    label: "Screen Watcher",
    command: ["npm", "run", "watch"],
    blurb: "Observes the screen every ~2 min and appends summaries to the activity trail.",
    freshness: async () => {
      const { fresh, ageMs } = mtimeWithin(ACTIVITY_LOG, 10 * 60 * 1000);
      return { fresh, detail: `last observation ${ago(ageMs)}` };
    },
  },
  {
    name: "newsroom",
    label: "Newsroom",
    command: ["npm", "run", "newsroom"],
    blurb: "Writes The Understory — discovers leads and moves articles through the pipeline.",
    freshness: async () => {
      try {
        const state = await prisma.daemonState.findUnique({ where: { id: 1 } });
        if (!state) return { fresh: null, detail: "no daemon state yet" };
        return { fresh: state.status === "RUNNING", detail: `daemon ${state.status.toLowerCase()}, next check ${state.nextCheckAt ? new Date(state.nextCheckAt).toLocaleTimeString("en-US", { hour12: false }) : "—"}` };
      } catch {
        return { fresh: null, detail: "newsroom.db unreachable" };
      }
    },
  },
  {
    name: "leash-cron",
    label: "Cron",
    command: ["npx", "tsx", "apps/leash-cron/src/main.ts"],
    blurb: "The scheduler — fires jobs (dream, tag-photos) and recurring tasks on time.",
    freshness: async () => {
      const { fresh, ageMs } = mtimeWithin(CRON_HEARTBEAT, 2 * 60 * 1000);
      return { fresh, detail: `heartbeat ${ago(ageMs)}` };
    },
  },
  {
    name: "leash-broker",
    label: "Serve Broker",
    command: ["npx", "tsx", "apps/leash-broker/src/main.ts"],
    blurb: `Priority queue in front of the serve (:${BROKER_PORT}) — serializes per-model, prioritizes chat over background, never collides. Point QVAC_OPENAI_URL at it to use.`,
    freshness: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${BROKER_PORT}/__broker/stats`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return { fresh: false, detail: "not answering" };
        const s = (await r.json()) as { served?: number; aliases?: Record<string, { queued: number }> };
        const queued = Object.values(s.aliases ?? {}).reduce((n, a) => n + (a.queued ?? 0), 0);
        return { fresh: true, detail: `${s.served ?? 0} served · ${queued} queued` };
      } catch {
        return { fresh: null, detail: "not running" };
      }
    },
  },
];

export interface ServiceStatus {
  name: ServiceName;
  label: string;
  blurb: string;
  /** "running" (our pid alive) | "external" (signal fresh, pid not ours) | "stopped". */
  state: "running" | "external" | "stopped" | "starting" | "ready" | "unhealthy";
  pid: number | null;
  fresh: boolean | null;
  detail: string;
  /** Whether Stop can work (we own a live pid; the serve is port-discovered). */
  stoppable: boolean;
  /** Last lines of the service log (supervised spawns only). */
  logTail: string[];
}

interface PidRecord {
  pid: number;
  startedAt: number;
}

const pidFile = (name: string): string => join(SERVICES_DIR, `${name}.json`);
const logFile = (name: string): string => join(SERVICES_DIR, `${name}.log`);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Last `n` lines of a service's log (empty when none). */
export function readLogTail(name: ServiceName, n = 20): string[] {
  const file = name === "qvac-serve" ? (process.env["LEASH_SERVE_LOG"] ?? join(DATA_DIR, "leash-serve.log")) : logFile(name);
  try {
    const raw = readFileSync(file, "utf8");
    return raw.split("\n").filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

async function genericStatus(def: ServiceDef): Promise<ServiceStatus> {
  const rec = await readJson<PidRecord | null>(pidFile(def.name), null);
  const ours = rec !== null && pidAlive(rec.pid);
  const { fresh, detail } = await def.freshness();
  const state: ServiceStatus["state"] = ours ? "running" : fresh ? "external" : "stopped";
  return {
    name: def.name,
    label: def.label,
    blurb: def.blurb,
    state,
    pid: ours ? (rec as PidRecord).pid : null,
    fresh,
    detail,
    stoppable: ours,
    logTail: readLogTail(def.name),
  };
}

/** Status of every service, serve included (one list for the console). */
export async function servicesStatus(): Promise<ServiceStatus[]> {
  const serve = await serveStatus();
  const serveRow: ServiceStatus = {
    name: "qvac-serve",
    label: "Model Serve",
    blurb: "qvac serve openai — every model the assistant runs on. Manage models in Brain → Models.",
    state: serve.state,
    pid: serve.pid,
    fresh: serve.state === "ready",
    detail:
      serve.state === "ready"
        ? `${serve.ready.length} model(s) ready${serve.inflight > 0 ? ` · ${serve.inflight} generation(s) in flight` : ""}`
        : serve.state,
    stoppable: serve.state !== "stopped",
    logTail: readLogTail("qvac-serve"),
  };
  const rest = await Promise.all(DEFS.map(genericStatus));
  return [serveRow, ...rest];
}

/** Start a generic service (detached, log-file stdio). The serve has its own path. */
export async function startService(name: ServiceName): Promise<{ ok: boolean; error?: string; pid?: number }> {
  if (name === "qvac-serve") return startServe();
  const def = DEFS.find((d) => d.name === name);
  if (!def) return { ok: false, error: `unknown service "${name}"` };
  const status = await genericStatus(def);
  if (status.state === "running") return { ok: false, error: `${def.label} is already running (pid ${status.pid})` };
  if (status.state === "external") return { ok: false, error: `${def.label} appears to be running outside the dashboard — stop it there first` };

  if (name === "leash-cron" && !existsSync(join(ROOT, "apps", "leash-cron", "src", "main.ts"))) {
    return { ok: false, error: "leash-cron isn't built yet" };
  }
  mkdirSync(SERVICES_DIR, { recursive: true });
  const log = openSync(logFile(name), "a");
  try {
    const child = spawn(def.command[0] as string, def.command.slice(1), { cwd: ROOT, detached: true, stdio: ["ignore", log, log] });
    child.unref();
    if (child.pid === undefined) return { ok: false, error: "spawn returned no pid" };
    await writeJson(pidFile(name), { pid: child.pid, startedAt: Date.now() } satisfies PidRecord);
    return { ok: true, pid: child.pid };
  } finally {
    closeSync(log);
  }
}

/** Stop a generic service we own (SIGTERM, ~8s grace). The serve has its own path. */
export async function stopService(name: ServiceName): Promise<{ ok: boolean; error?: string }> {
  if (name === "qvac-serve") return stopServe();
  const rec = await readJson<PidRecord | null>(pidFile(name), null);
  if (!rec || !pidAlive(rec.pid)) {
    await writeJson(pidFile(name), null);
    return { ok: true };
  }
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch {
    /* gone already */
  }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!pidAlive(rec.pid)) break;
  }
  if (pidAlive(rec.pid)) return { ok: false, error: "process did not exit within 8s" };
  await writeJson(pidFile(name), null);
  return { ok: true };
}
