/**
 * qvac-serve process supervision (server-only) — stateless re-discovery, never a held
 * child handle.
 *
 *   · start: spawn DETACHED+unref the repo's LOCAL, vision-patched `@qvac/cli` (resolved via
 *     `createRequire` → `dist/index.js`) with this process's Node — `node <cli> serve openai
 *     --port <port>`. NOT unpinned `npx`: npx-latest fetches an UNPATCHED cli that silently drops
 *     `image_url` content → cross-mesh vision borrow replies "I can't see images". cwd = the
 *     mycelium root — LOAD-BEARING: the CLI find-ups `qvac.config.*` (the `.mjs` wrapper) from cwd.
 *     With the direct `node` spawn the spawned pid IS the listener. Pid recorded in
 *     `data/leash-serve.json`; output appended to `data/leash-serve.log`.
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
import { openSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson, DATA_DIR } from "./json-store.ts";
import { QVAC_OPENAI_URL, liveModels } from "./models.ts";
import { inflightCount } from "./inflight.ts";

const ROOT = join(DATA_DIR, "..");
const PIDFILE = process.env["LEASH_SERVE_PIDFILE"] ?? join(DATA_DIR, "leash-serve.json");
const LOGFILE = process.env["LEASH_SERVE_LOG"] ?? join(DATA_DIR, "leash-serve.log");
/** Port from QVAC_OPENAI_URL (default 11435). */
const PORT = Number(new URL(QVAC_OPENAI_URL).port || 11435);

/**
 * Entry shim for the PACKAGED serve (Electron-as-Node). Under ELECTRON_RUN_AS_NODE,
 * `process.versions.electron` is set but `process.defaultApp` is undefined, so commander
 * (in @qvac/cli) reads argv as a packaged-electron app and slices only argv[0] — mistaking
 * the cli's own path for the command (`error: unknown command '…/@qvac/cli/dist/index.js'`).
 * Marking `defaultApp` restores the node-style exe+script slice; then we import the real
 * (ESM) cli unchanged. Spawned as the entry so the path is a spawn arg (space-safe), not in
 * NODE_OPTIONS. The dev/`npx` path never hits this.
 */
const SERVE_SHIM = `import { pathToFileURL } from "node:url";
try { Object.defineProperty(process, "defaultApp", { value: true, configurable: true }); } catch {}
await import(pathToFileURL(process.env.LEASH_QVAC_CLI).href);
`;

/**
 * Resolve the repo's LOCAL @qvac/cli entry (`dist/index.js`). This is the version pinned in
 * package.json (`^0.6.0`) and patched by patch-package's postinstall (OpenAI `image_url` content
 * → SDK `attachments`) — the SAME version+patch the packaged app ships, so cross-mesh VISION
 * borrow works. `exports` is the bare `"./dist/index.js"`, so `require.resolve("@qvac/cli")`
 * returns the entry directly (and `@qvac/cli/package.json` is NOT exported — don't resolve that).
 * Returns null if resolution fails (→ caller falls back to a PINNED npx).
 *
 * `createRequire` is obtained via `process.getBuiltinModule` — NOT `import { createRequire } from
 * "node:module"`. The static import makes Next's webpack instrument the returned require and try to
 * statically bundle the `.resolve("@qvac/cli")` literal, which drags @qvac/sdk's dynamic
 * `dist/server/worker.js` path into the build (module-not-found) and traces @qvac/cli's native
 * prebuilds into `.next/standalone`. `getBuiltinModule` is opaque to webpack, so @qvac/cli stays
 * fully out of the bundle and this resolves natively at runtime (Node ≥ 22.3 / we're on 24).
 */
function localCliEntry(): string | null {
  try {
    const { createRequire } = process.getBuiltinModule("node:module");
    return createRequire(import.meta.url).resolve("@qvac/cli");
  } catch {
    return null;
  }
}

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
    // "ours" if the listener IS our recorded pid (the common case: direct `node <cli>` and the
    // packaged shim both make the spawned pid the listener), or our recorded pid is still alive
    // and the listener is its child (the npx-fallback path, where `npx` wraps the real process).
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
    // Packaged desktop: run the BUNDLED qvac CLI with Electron's own Node (LEASH_QVAC_CLI +
    // LEASH_NODE_BIN set by the shell) — no system Node, no `npx` download. Dev: run the repo's
    // LOCAL patched @qvac/cli directly with `node` (PINNED npx only as a last-resort fallback).
    const bundledCli = process.env["LEASH_QVAC_CLI"];
    const nodeBin = process.env["LEASH_NODE_BIN"] ?? process.execPath;
    let cmd: string;
    let args: string[];
    if (bundledCli) {
      // Bundled: run the cli through the defaultApp shim (see SERVE_SHIM) so commander parses argv
      // correctly under ELECTRON_RUN_AS_NODE. The shim imports the cli from $LEASH_QVAC_CLI (in env).
      const shim = join(DATA_DIR, "qvac-serve-shim.mjs");
      writeFileSync(shim, SERVE_SHIM);
      cmd = nodeBin;
      args = [shim, "serve", "openai", "--port", String(PORT)];
    } else {
      // Dev: run the repo's LOCAL, vision-patched @qvac/cli with this process's Node — the same
      // version (^0.6.0) + patch the packaged app ships, so cross-mesh VISION (image_url →
      // attachments) works. The spawned pid IS the listener (no npx wrapper).
      const cliEntry = localCliEntry();
      if (cliEntry) {
        cmd = process.execPath;
        args = [cliEntry, "serve", "openai", "--port", String(PORT)];
      } else {
        // Fallback only: PINNED npx (never unpinned — npx-latest fetches an UNPATCHED cli that
        // silently drops images → "I can't see images"). Vision needs the patched local install.
        console.warn(
          "[serve-control] local @qvac/cli unresolvable; falling back to `npx @qvac/cli@0.6.0`. " +
            "Cross-mesh VISION needs the repo's patched local install — run `npm install`.",
        );
        cmd = "npx";
        args = ["@qvac/cli@0.6.0", "serve", "openai", "--port", String(PORT)];
      }
    }
    const child = spawn(cmd, args, {
      cwd: ROOT, // load-bearing: the CLI resolves qvac.config.* (the .mjs wrapper) upward from cwd
      detached: true,
      stdio: ["ignore", log, log],
      // ELECTRON_RUN_AS_NODE makes the Electron binary behave as Node for the bundled CLI.
      env: bundledCli ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
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
