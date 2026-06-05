/**
 * qvac-serve process supervision (server-only) — stateless re-discovery, never a held
 * child handle.
 *
 *   · start: spawn DETACHED+unref `npx @qvac/cli serve openai --port <port>` with
 *     cwd = the mycelium root — LOAD-BEARING: the CLI find-ups `qvac.config.json`
 *     from cwd. Pid recorded in `data/leash-serve.json`; output appended to
 *     `data/leash-serve.log`.
 *   · status: pidfile probe + `lsof` listener probe + HTTP `/v1/models` probe. The
 *     serve doesn't open its port until preload completes, so:
 *       port answers → READY · pid alive, port closed → STARTING ·
 *       listener exists but isn't our pid → READY (adopted — e.g. `npm run qvac` by
 *       hand; supervision is re-discovery, not ownership) · neither → STOPPED ·
 *       port open but /v1/models errors → UNHEALTHY
 *   · stop: SIGTERM the discovered pid. CALLERS MUST GUARD with `inflightCount()` —
 *     killing the serve mid-generation is the GPU-wedge by another knife. The route
 *     409s; this module still refuses as a second line of defense.
 */
import "server-only";
import { spawn, execFile } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson, DATA_DIR } from "./json-store.ts";
import { QVAC_OPENAI_URL, liveModels } from "./models.ts";
import { inflightCount } from "./inflight.ts";

const ROOT = join(DATA_DIR, "..");
const PIDFILE = process.env["LEASH_SERVE_PIDFILE"] ?? join(DATA_DIR, "leash-serve.json");
const LOGFILE = process.env["LEASH_SERVE_LOG"] ?? join(DATA_DIR, "leash-serve.log");
/** Port from QVAC_OPENAI_URL (default 11435). */
const PORT = Number(new URL(QVAC_OPENAI_URL).port || 11435);

export type ServeState = "stopped" | "starting" | "ready" | "unhealthy";

export interface ServeStatus {
  state: ServeState;
  /** The serving process pid when known (ours or adopted). */
  pid: number | null;
  /** Whether the pid came from our pidfile (false = adopted external process). */
  ours: boolean;
  /** READY model aliases when state === "ready". */
  ready: string[];
  port: number;
  /** Generations the web process currently has in flight (stop/restart refuse > 0). */
  inflight: number;
}

interface PidRecord {
  pid: number;
  startedAt: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid LISTENING on the serve port (never client sockets), or null. */
function listenerPid(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-ti", `TCP:${PORT}`, "-sTCP:LISTEN"], (err, stdout) => {
      if (err) return resolve(null); // lsof exits 1 when nothing matches
      const pid = Number(stdout.trim().split("\n")[0]);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

/** Current serve state — pure re-discovery (pidfile + lsof + HTTP), no held handles. */
export async function serveStatus(): Promise<ServeStatus> {
  const [rec, listener, live] = await Promise.all([readJson<PidRecord | null>(PIDFILE, null), listenerPid(), liveModels()]);
  const inflight = inflightCount();

  if (live.up) {
    const pid = listener ?? rec?.pid ?? null;
    // "ours" if the listener IS our recorded pid, or our recorded npx wrapper is
    // still alive (the listener is its child — `npx @qvac/cli` wraps the real process).
    const ours = rec?.pid != null && (rec.pid === pid || pidAlive(rec.pid));
    return { state: "ready", pid, ours, ready: live.ready, port: PORT, inflight };
  }
  if (listener) {
    // Port open but /v1/models failed → listening yet not answering correctly.
    return { state: "unhealthy", pid: listener, ours: rec?.pid === listener, ready: [], port: PORT, inflight };
  }
  if (rec && pidAlive(rec.pid)) {
    // Process alive but port not open yet = preloading models.
    return { state: "starting", pid: rec.pid, ours: true, ready: [], port: PORT, inflight };
  }
  return { state: "stopped", pid: null, ours: false, ready: [], port: PORT, inflight };
}

/** Start the serve (detached). No-op error if it's already running/starting. */
export async function startServe(): Promise<{ ok: boolean; error?: string; pid?: number }> {
  const status = await serveStatus();
  if (status.state !== "stopped") return { ok: false, error: `serve is ${status.state} (pid ${status.pid ?? "?"})` };

  // Append both stdio streams to the logfile; the fd is closed in the parent after
  // spawn — the detached child keeps its own copy (no held handle in Next).
  const log = openSync(LOGFILE, "a");
  try {
    const child = spawn("npx", ["@qvac/cli", "serve", "openai", "--port", String(PORT)], {
      cwd: ROOT, // load-bearing: the CLI resolves qvac.config.json upward from cwd
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    if (child.pid === undefined) return { ok: false, error: "spawn returned no pid" };
    await writeJson(PIDFILE, { pid: child.pid, startedAt: Date.now() } satisfies PidRecord);
    return { ok: true, pid: child.pid };
  } finally {
    closeSync(log);
  }
}

/**
 * Stop the serve (SIGTERM the LISTENER pid, ours or adopted). Refuses while any
 * generation is in flight. Waits up to ~10s for the port to close.
 */
export async function stopServe(): Promise<{ ok: boolean; error?: string }> {
  if (inflightCount() > 0) return { ok: false, error: `refusing to stop: ${inflightCount()} generation(s) in flight` };
  const status = await serveStatus();
  if (status.state === "stopped") return { ok: true };
  const pid = status.pid;
  if (!pid) return { ok: false, error: "serve looks alive but no pid found" };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  // Wait for the listener to vanish (max ~10s), then clear the pidfile.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await listenerPid()) === null && !pidAlive(pid)) break;
  }
  await writeJson(PIDFILE, null);
  if ((await listenerPid()) !== null) return { ok: false, error: "serve did not exit within 10s" };
  return { ok: true };
}
