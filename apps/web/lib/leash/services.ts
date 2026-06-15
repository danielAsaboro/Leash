/**
 * Service supervision (server-only) — the generic layer behind the /services console.
 *
 * Taxonomy (the house definitions): a SERVICE is the managed system around a DAEMON
 * (a long-running background process); daemons produce TASKS (units of work that run,
 * finish, exit). This module supervises the daemons:
 *
 *   · watcher     — `npm run watch` (screen observations → leash-activity.jsonl)
 *   · newsroom    — `npm run newsroom` (the paper's pipeline daemon)
 *   · mcp-cron    — `npx -y mcp-cron --transport http` (the scheduling engine)
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
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync, statSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, DATA_DIR } from "./json-store.ts";
import { ACTIVITY_LOG } from "./graph.ts";
import { prisma } from "../db.ts";
import { daemonsRoot, daemonsReady, spawnDaemon } from "./daemons.ts";
import { serveStatus, startServe, stopServe } from "./serve-control.ts";

const ROOT = join(DATA_DIR, "..");

/**
 * The Mycelium monorepo root — where the daemons' `apps/<x>/src/main.ts` live, so they can be
 * spawned with `npx tsx`. Resolved by walking up from this module (works under `npm run dev`).
 * In a PACKAGED build (the desktop DMG ships only the Next standalone bundle, not the daemon
 * source) this is null, and the services are reported as unavailable instead of crash-spawning a
 * `tsx apps/hypha/src/main.ts` that doesn't exist. NOTE: distinct from ROOT (the per-user *data*
 * dir) — daemons run from the code root but inherit the user-scoped env (HYPHA_DATA_DIR, …).
 */
const CODE_ROOT: string | null = (() => {
  let dir = dirname(fileURLToPath(import.meta.url)); // apps/web/lib/leash
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "apps", "hypha", "src", "main.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
})();

export const SERVICES_DIR = process.env["LEASH_SERVICES_DIR"] ?? join(DATA_DIR, "leash-services");

export type ServiceName = "qvac-serve" | "watcher" | "newsroom" | "mcp-cron" | "leash-broker" | "hypha" | "leash-mcp" | "leash-tools-mcp";

/** Where the broker listens (probe target for its health). */
const BROKER_PORT = Number(process.env["LEASH_BROKER_PORT"] ?? 11436);
/** Where the Hypha delegated-compute shim listens (probe target for its health). */
const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
/** Where the Leash MCP server (mesh-pairing tools) listens (probe target for its health). */
const LEASH_MCP_PORT = Number(process.env["LEASH_MCP_PORT"] ?? 11439);
const LEASH_TOOLS_MCP_PORT = Number(process.env["LEASH_TOOLS_MCP_PORT"] ?? 11440);
/** Where the mcp-cron scheduling engine listens (localhost-only; the cron-client connects over Streamable HTTP). */
const MCP_CRON_PORT = Number(process.env["LEASH_CRON_MCP_PORT"] ?? 11448);
/** mcp-cron's SQLite result/task store, scoped to this user's data dir (NOT the ~/.mcp-cron default). */
const MCP_CRON_DB = process.env["LEASH_CRON_DB"] ?? join(DATA_DIR, "mcp-cron.db");

interface ServiceDef {
  name: Exclude<ServiceName, "qvac-serve">;
  label: string;
  command: string[];
  /** What the daemon is for (shown on the card). */
  blurb: string;
  /** Freshness: true=signal fresh, false=signal stale, null=no signal yet. */
  freshness: () => Promise<{ fresh: boolean | null; detail: string }>;
  /**
   * A unique substring of the daemon's command line. If set, the card offers "Force stop":
   * find EVERY matching process (even ones started outside the dashboard / orphaned) and
   * kill them. NEVER set this for qvac-serve — SIGKILL mid-decode is the GPU-wedge hazard.
   */
  procMatch?: string;
  /**
   * The freshness signal flips true quickly once truly ready (an HTTP health probe). When set,
   * a just-started daemon shows "Starting…" until its probe answers — instead of "Running" the
   * instant the pid exists. (mtime/db-based services don't get this; their signal lags by design.)
   */
  readyProbe?: boolean;
  /**
   * The daemon's private state directory. When set, the card offers "Reset": force-stop,
   * wipe this directory, start fresh. The always-works escape hatch for wedged identity/
   * pairing state (hypha: seed + mesh-store + invite + tombstones).
   */
  dataDir?: string;
  /** Extra env DEFAULTS for the spawned daemon (the parent's process.env still wins). */
  env?: Record<string, string>;
  /**
   * Hide from the /services console — the daemon is supervised THROUGH another surface
   * (e.g. the `leash-mcp` daemon's lifecycle is owned by the "Mesh Tools" toggle in
   * Brain → MCP). `startService`/`stopService` still work by name; only the card is gone.
   */
  internal?: boolean;
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
    procMatch: "apps/leash-watch/src/main.ts",
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
    procMatch: "apps/newsroom/src/main.ts",
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
    name: "mcp-cron",
    label: "Scheduler",
    // The scheduling ENGINE — a detached Streamable-HTTP MCP daemon (jolks/mcp-cron, launched via
    // `npx -y mcp-cron`, NOT `npx tsx`). Bound to localhost; the cron-client owns the connection.
    // Tasks it runs INHERIT this daemon's env (proven in spike/09-mcp-cron.ts), so the scope env
    // (LEASH_DATA_DIR / LEASH_WEB_PORT / LEASH_INTERNAL_TOKEN_FILE …) reaches every scheduled
    // shell task with zero per-task plumbing. No --log-file: in HTTP mode stdout is NOT the
    // protocol channel, so we let the supervisor capture it into the Services log tail.
    command: ["npx", "-y", "mcp-cron", "--transport", "http", "--address", "127.0.0.1", "--port", String(MCP_CRON_PORT), "--db-path", MCP_CRON_DB],
    procMatch: "mcp-cron",
    readyProbe: true,
    blurb: `Scheduling engine (:${MCP_CRON_PORT}) — runs the assistant's jobs, heartbeats, and tasks on real cron schedules, with a queryable SQLite run history.`,
    freshness: async () => {
      // mcp-cron exposes no /health route — any HTTP response on the MCP endpoint means the
      // listener is up (a GET without an MCP session is rejected, but it still answers).
      try {
        const r = await fetch(`http://127.0.0.1:${MCP_CRON_PORT}/`, { method: "GET", signal: AbortSignal.timeout(1500) });
        return { fresh: r.status > 0, detail: `listening on :${MCP_CRON_PORT}` };
      } catch {
        return { fresh: null, detail: "not running" };
      }
    },
  },
  {
    name: "leash-broker",
    label: "Serve Broker",
    command: ["npx", "tsx", "apps/leash-broker/src/main.ts"],
    procMatch: "apps/leash-broker/src/main.ts",
    readyProbe: true,
    // Overflow to the local Hypha shim by default — the dashboard supervises hypha right
    // next to the broker, and overflow is inert until warm mesh peers actually exist.
    env: { LEASH_BROKER_HYPHA_URL: `http://127.0.0.1:${HYPHA_PORT}` },
    blurb: `Priority queue in front of the serve (:${BROKER_PORT}) — serializes per-model, prioritizes chat over background, never collides. Point QVAC_OPENAI_URL at it to use.`,
    freshness: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${BROKER_PORT}/__broker/stats`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return { fresh: false, detail: "not answering" };
        const s = (await r.json()) as { served?: number; aliases?: Record<string, { queued: number }>; overflow?: { shed?: number; availabilityRouted?: number } };
        const queued = Object.values(s.aliases ?? {}).reduce((n, a) => n + (a.queued ?? 0), 0);
        const borrowed = (s.overflow?.shed ?? 0) + (s.overflow?.availabilityRouted ?? 0);
        return { fresh: true, detail: `${s.served ?? 0} served · ${queued} queued${borrowed > 0 ? ` · ${borrowed} shed→peer` : ""}` };
      } catch {
        return { fresh: null, detail: "not running" };
      }
    },
  },
  {
    name: "hypha",
    label: "Mesh (Hypha)",
    command: ["npx", "tsx", "apps/hypha/src/main.ts"],
    procMatch: "apps/hypha/src/main.ts",
    readyProbe: true,
    dataDir: join(ROOT, "data", "hypha"),
    blurb: `Delegated-compute daemon (:${HYPHA_PORT}) — joins the encrypted mesh, serves paired peers, pre-warms their models, and is the broker's overflow path. Pair peers via \`npm run hypha invite\` / \`npm run hypha pair <code>\`.`,
    freshness: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${HYPHA_PORT}/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return { fresh: false, detail: "not answering" };
        const s = (await r.json()) as { peers?: number; warmAliases?: string[]; inflight?: number };
        const warm = s.warmAliases?.length ?? 0;
        return { fresh: true, detail: `${s.peers ?? 0} peer(s) · ${warm} warm model(s)${(s.inflight ?? 0) > 0 ? ` · ${s.inflight} delegating` : ""}` };
      } catch {
        return { fresh: null, detail: "not running" };
      }
    },
  },
  {
    name: "leash-mcp",
    label: "MCP (Mesh Tools)",
    command: ["npx", "tsx", "apps/leash-mcp/src/main.ts"],
    procMatch: "apps/leash-mcp/src/main.ts",
    readyProbe: true,
    // Supervised through the "Mesh Tools" built-in toggle in Brain → MCP (no Services card).
    internal: true,
    blurb: `MCP server (:${LEASH_MCP_PORT}) exposing mesh pairing as assistant tools — "pair this device with my laptop" becomes an in-chat flow with the PIN asked as a form.`,
    freshness: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${LEASH_MCP_PORT}/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return { fresh: false, detail: "not answering" };
        const s = (await r.json()) as { sessions?: number };
        return { fresh: true, detail: `${s.sessions ?? 0} session(s)` };
      } catch {
        return { fresh: null, detail: "not running" };
      }
    },
  },
  {
    name: "leash-tools-mcp",
    label: "Tool Servers",
    command: ["npx", "tsx", "apps/leash-tools-mcp/src/main.ts"],
    procMatch: "apps/leash-tools-mcp/src/main.ts",
    readyProbe: true,
    // ONE daemon hosting every tool group as its own MCP server; supervised through the
    // per-group built-in toggles in Brain → MCP (reference-counted — see mcp-lifecycle.ts).
    internal: true,
    blurb: `MCP daemon (:${LEASH_TOOLS_MCP_PORT}) hosting the Leash tool groups (Home Assistant, Feed, Memory, Tasks, Context, Photos, Image) — each a separately-toggleable MCP server.`,
    freshness: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${LEASH_TOOLS_MCP_PORT}/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return { fresh: false, detail: "not answering" };
        const s = (await r.json()) as { sessions?: number; groups?: unknown[] };
        return { fresh: true, detail: `${s.groups?.length ?? 0} group(s), ${s.sessions ?? 0} session(s)` };
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
  /** Whether "Force stop" is offered (kills EVERY matching process, even external/orphaned). */
  forceStoppable: boolean;
  /** Whether "Reset" is offered (force-stop + wipe the daemon's data dir + start fresh). */
  resettable: boolean;
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

/** PIDs whose full command line contains `match` (via `pgrep -f`). Empty if none / unavailable. */
function pgrepF(match: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", match], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep exits non-zero when there are no matches
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
  // Our pid is alive but a readyProbe service hasn't answered yet → "starting", not "running".
  const state: ServiceStatus["state"] = ours ? (def.readyProbe && fresh !== true ? "starting" : "running") : fresh ? "external" : "stopped";
  return {
    name: def.name,
    label: def.label,
    blurb: def.blurb,
    state,
    pid: ours ? (rec as PidRecord).pid : null,
    fresh,
    detail: state === "starting" ? "starting up…" : detail,
    stoppable: ours,
    forceStoppable: Boolean(def.procMatch) && (state === "running" || state === "external" || state === "starting"),
    resettable: Boolean(def.dataDir),
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
    forceStoppable: false, // never SIGKILL the serve — GPU-wedge hazard mid-decode
    resettable: false,
    logTail: readLogTail("qvac-serve"),
  };
  const rest = await Promise.all(DEFS.filter((d) => !d.internal).map(genericStatus));
  return [serveRow, ...rest];
}

/**
 * Force stop: find EVERY process whose command line matches the service's `procMatch` —
 * including copies started outside the dashboard or orphaned — and kill them (SIGTERM, then
 * SIGKILL after a grace). This is the non-technical "it's stuck, just clear it" button. The
 * serve has no procMatch, so it can never be force-killed here (wedge safety).
 */
export async function forceStopService(name: ServiceName): Promise<{ ok: boolean; error?: string; killed?: number }> {
  const def = DEFS.find((d) => d.name === name);
  if (!def?.procMatch) return { ok: false, error: "Force stop isn't available for this service." };

  const pids = pgrepF(def.procMatch).filter((p) => p !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Grace, then SIGKILL whatever's left.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (!pids.some((p) => pidAlive(p))) break;
  }
  for (const pid of pids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await writeJson(pidFile(name), null); // we no longer own anything
  const survivors = pids.filter((p) => pidAlive(p));
  if (survivors.length > 0) return { ok: false, error: `couldn't kill pid(s) ${survivors.join(", ")}`, killed: pids.length - survivors.length };
  return { ok: true, killed: pids.length };
}

/**
 * Reset: force-stop every copy, wipe the daemon's private state directory, start fresh.
 * For hypha this deletes the device's mesh identity (seed), the mesh corestore, the invite,
 * and the tombstones — the device comes back unpaired with a brand-new writer key. Other
 * devices keep their state; the user re-pairs afterwards. Only offered for defs with dataDir.
 */
export async function resetService(name: ServiceName): Promise<{ ok: boolean; error?: string; pid?: number }> {
  const def = DEFS.find((d) => d.name === name);
  if (!def?.dataDir) return { ok: false, error: "Reset isn't available for this service." };
  const stopped = await forceStopService(name);
  if (!stopped.ok) return { ok: false, error: stopped.error };
  try {
    rmSync(def.dataDir, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `couldn't wipe ${def.dataDir}: ${String(err)}` };
  }
  return startService(name);
}

/** Start a generic service (detached, log-file stdio). The serve has its own path. */
export async function startService(name: ServiceName): Promise<{ ok: boolean; error?: string; pid?: number }> {
  if (name === "qvac-serve") return startServe();
  const def = DEFS.find((d) => d.name === name);
  if (!def) return { ok: false, error: `unknown service "${name}"` };
  const status = await genericStatus(def);
  if (status.state === "running") return { ok: false, error: `${def.label} is already running (pid ${status.pid})` };
  if (status.state === "external") return { ok: false, error: `${def.label} appears to be running outside the dashboard — stop it there first` };

  // The daemon entry, e.g. "apps/hypha/src/main.ts" (all daemons are spawned as `npx tsx <entry>`).
  const srcRel = def.command[0] === "npx" && def.command[1] === "tsx" ? def.command[2] : null;

  // PACKAGED: run from the on-demand "leash-daemons" overlay via the bundled runtime (no system
  // node/npx). DEV: `npx tsx <entry>` from the monorepo (CODE_ROOT).
  const overlay = daemonsRoot();
  if (overlay) {
    if (!srcRel) return { ok: false, error: `${def.label} has no script entry to run.` };
    if (!daemonsReady()) {
      return { ok: false, error: `${def.label} is still being set up — the daemon bundle is downloading in the background. Try again in a moment.` };
    }
    if (!existsSync(join(overlay, srcRel))) {
      return { ok: false, error: `${def.label} isn't in the daemon bundle (missing ${srcRel}).` };
    }
  } else {
    if (!CODE_ROOT) {
      return { ok: false, error: `${def.label} isn't available in this build — it runs from the Mycelium repo, which isn't bundled in the app.` };
    }
    if (srcRel && !existsSync(join(CODE_ROOT, srcRel))) {
      return { ok: false, error: `${def.label} isn't available in this build (missing ${srcRel}).` };
    }
  }

  mkdirSync(SERVICES_DIR, { recursive: true });
  // Truncate ("w") so each Start/Restart begins with a clean log — old runs' noise is cleared.
  const log = openSync(logFile(name), "w");
  try {
    // The daemon inherits the user-scoped env. Packaged → bundled-runtime launch; dev → npx tsx.
    const child = overlay
      ? spawnDaemon(srcRel as string, { detached: true, stdio: ["ignore", log, log], env: { ...def.env, ...process.env } })
      : spawn(def.command[0] as string, def.command.slice(1), { cwd: CODE_ROOT as string, detached: true, stdio: ["ignore", log, log], env: { ...def.env, ...process.env } });
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
