#!/usr/bin/env node
/**
 * THE supervisor — the single, shared lifecycle for running the Leash dashboard isolated per
 * user. Used identically by:
 *   · standalone web   — `npm run dev` / `npm run start` (wraps `next dev` / `next start`)
 *   · the desktop app  — Electron main spawns THIS file (LEASH_SERVER_JS = bundled standalone)
 *
 * It owns the process: spawns the Next server scoped to the active user (per `<base>/Leash/
 * active.json`), and on child EXIT re-reads active.json and respawns in the new scope — which is
 * how the web auth routes' login / switch / logout / reset take effect (they write active.json
 * then exit). On a scope change it reaps the detached `qvac serve` on the serve port so a new
 * user never inherits the previous user's serve/corestore. There is NO unsupervised path.
 *
 * Env contract (all optional; sensible repo-relative defaults):
 *   LEASH_BASE            install base; `<base>/Leash/` holds users + per-user dirs   [default: ~]
 *   PORT                  web port                                                    [default: 6801]
 *   LEASH_SERVER_CMD      wrap a command, e.g. "npx next dev" / "npx next start"
 *   LEASH_SERVER_JS       run a standalone server.js with node (production)
 *   LEASH_RUNTIME_SRC     read-only bundled standalone root to SEED into <base>/Leash/_runtime
 *   LEASH_QVAC_CONFIG_SRC dir holding qvac.config.* to seed into each user scope    [default: repo root]
 *   LEASH_DB_TEMPLATE     empty migrated newsroom.db to seed a fresh user           [default: desktop resources]
 *   MYCELIUM_SERVE_PORT   qvac serve port to reap on switch                          [default: 11435]
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_USER,
  leashBaseFrom,
  runtimeDir as runtimeDirOf,
  sharedNpmCache,
  registryFile,
  activeFile,
  userScope,
  userEnv,
} from "./lib/leash/scope.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web
const REPO_ROOT = join(here, "..", "..");

// ── config ──────────────────────────────────────────────────────────────────────────
const BASE = process.env.LEASH_BASE ?? userInfo().homedir; // passwd home (stable across GUI/CLI $HOME)
const LEASH_BASE = leashBaseFrom(BASE);
const ACTIVE_FILE = activeFile(LEASH_BASE);
const REGISTRY_FILE = registryFile(LEASH_BASE);
const WEB_PORT = Number(process.env.PORT ?? 6801);
const SERVE_PORT = Number(process.env.MYCELIUM_SERVE_PORT ?? 11435);
const SERVER_CMD = process.env.LEASH_SERVER_CMD ?? "";
const RUNTIME_SRC = process.env.LEASH_RUNTIME_SRC ?? "";
const QVAC_CONFIG_SRC = process.env.LEASH_QVAC_CONFIG_SRC ?? REPO_ROOT;
const DB_TEMPLATE = process.env.LEASH_DB_TEMPLATE ?? join(REPO_ROOT, "apps", "desktop", "resources", "newsroom-template.db");
const DEFAULT_STANDALONE = join(here, ".next", "standalone");

// ── active.json + registry ────────────────────────────────────────────────────────────
function readActive() {
  try {
    const a = JSON.parse(readFileSync(ACTIVE_FILE, "utf8"));
    if (a && (a.userId === null || typeof a.userId === "string")) return a;
  } catch {
    /* missing */
  }
  return { userId: null };
}
function writeActive(state) {
  mkdirSync(LEASH_BASE, { recursive: true });
  const tmp = join(LEASH_BASE, `.active.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, ACTIVE_FILE);
}
function userExists(userId) {
  try {
    const r = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    return Array.isArray(r.users) && r.users.some((u) => u.userId === userId);
  } catch {
    return false;
  }
}
function performPendingOp() {
  const a = readActive();
  if (!a.op) return;
  if (a.op === "reset-factory") {
    rmSync(LEASH_BASE, { recursive: true, force: true });
    return;
  }
  if (a.op === "reset-user" && a.target) rmSync(userScope(LEASH_BASE, a.target).scopeDir, { recursive: true, force: true });
  writeActive({ userId: null });
}
function resolveScope() {
  const a = readActive();
  if (a.userId && userExists(a.userId)) return userScope(LEASH_BASE, a.userId);
  return userScope(LEASH_BASE, BOOTSTRAP_USER);
}

// ── seeding (idempotent) ──────────────────────────────────────────────────────────────
/** The Next build id of a runtime tree (changes every build) — used to detect a stale seed. */
function readBuildId(root) {
  try {
    return readFileSync(join(root, "apps", "web", ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Seed the read-only bundled standalone into a WRITABLE runtime (packaged desktop). RE-SEEDS when
 * the bundled build differs from the seeded one (BUILD_ID mismatch) — otherwise an app UPDATE would
 * keep running the previous version's stale runtime (this is exactly what served 404 static assets).
 */
function seedRuntime() {
  if (!RUNTIME_SRC) return DEFAULT_STANDALONE;
  const dst = runtimeDirOf(LEASH_BASE);
  if (!existsSync(join(RUNTIME_SRC, "apps", "web", "server.js"))) return dst;
  const srcId = readBuildId(RUNTIME_SRC);
  if (srcId && srcId === readBuildId(dst)) return dst; // already current
  rmSync(dst, { recursive: true, force: true }); // stale or missing → fresh copy
  mkdirSync(dst, { recursive: true });
  cpSync(RUNTIME_SRC, dst, { recursive: true });
  return dst;
}
/** Make a user scope runnable: dirs, shared npm cache, qvac.config, empty-DB template. */
function bootstrapScopeDir(scope) {
  for (const d of [scope.dataDir, join(scope.dbPath, ".."), sharedNpmCache(LEASH_BASE)]) mkdirSync(d, { recursive: true });
  if (existsSync(join(QVAC_CONFIG_SRC, "qvac.config.mjs")) && !existsSync(scope.configPath)) {
    for (const f of ["qvac.config.mjs", "qvac.config.base.json"]) {
      const src = join(QVAC_CONFIG_SRC, f);
      if (existsSync(src)) cpSync(src, join(scope.scopeDir, f));
    }
  }
  if (existsSync(DB_TEMPLATE) && !existsSync(scope.dbPath)) cpSync(DB_TEMPLATE, scope.dbPath);
}

// ── serve reaping ─────────────────────────────────────────────────────────────────────
function killServeOnPort() {
  return new Promise((done) => {
    execFile("lsof", ["-ti", `TCP:${SERVE_PORT}`, "-sTCP:LISTEN"], (_e, out) => {
      const pids = out.trim().split("\n").map(Number).filter((n) => Number.isFinite(n) && n > 0);
      for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
      if (!pids.length) return done();
      let waited = 0;
      const probe = () =>
        execFile("lsof", ["-ti", `TCP:${SERVE_PORT}`, "-sTCP:LISTEN"], (e2, o2) => {
          if (e2 || o2.trim() === "" || waited >= 10_000) return done();
          waited += 500;
          setTimeout(probe, 500);
        });
      setTimeout(probe, 500);
    });
  });
}

// ── lifecycle ───────────────────────────────────────────────────────────────────────────
let child = null;
let lastUserId = null;
let quitting = false;

async function spawnScoped() {
  performPendingOp();
  const runtimeRoot = seedRuntime();
  const scope = resolveScope();
  bootstrapScopeDir(scope);

  const newUserId = scope.userId === BOOTSTRAP_USER ? null : scope.userId;
  if (newUserId !== lastUserId) await killServeOnPort();
  lastUserId = newUserId;

  // Wrap a command (`next dev`/`next start`) or run the standalone server.js.
  let cmd, cmdArgs, cwd, nodeEnv;
  if (SERVER_CMD) {
    const parts = SERVER_CMD.split(/\s+/).filter(Boolean);
    [cmd, ...cmdArgs] = parts;
    cwd = here;
    nodeEnv = SERVER_CMD.includes("dev") ? "development" : "production";
  } else {
    const serverJs = process.env.LEASH_SERVER_JS ?? join(runtimeRoot, "apps", "web", "server.js");
    if (!existsSync(serverJs)) {
      console.error(`[launch] standalone server not found at ${serverJs}\n  → run \`npm run build\` first, or set LEASH_SERVER_CMD="npx next dev".`);
      process.exit(1);
    }
    cmd = process.execPath;
    cmdArgs = [serverJs];
    cwd = process.env.LEASH_SERVER_JS ? dirname(serverJs) : runtimeRoot;
    nodeEnv = "production";
  }

  // Bind localhost-only by default (Next standalone/`next dev` otherwise listen on 0.0.0.0, exposing
  // the dashboard to the whole LAN). Set HOSTNAME=0.0.0.0 explicitly to serve other devices.
  const hostname = process.env.HOSTNAME ?? "127.0.0.1";
  console.log(`[launch] Leash → ${newUserId ?? "(bootstrap)"} on ${hostname}:${WEB_PORT} — data: ${scope.dataDir}`);
  child = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, PORT: String(WEB_PORT), HOSTNAME: hostname, NODE_ENV: nodeEnv, ...userEnv(LEASH_BASE, scope) },
    stdio: "inherit",
  });
  child.on("exit", () => {
    child = null;
    if (quitting) return;
    setTimeout(spawnScoped, 300);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    quitting = true;
    if (child) child.kill("SIGTERM");
    void killServeOnPort().finally(() => process.exit(0));
  });
}

spawnScoped();
