/**
 * One-time migration: move the existing SHARED data (repo `data/`, the newsroom DB, and
 * `~/.qvac` models) under a single user's scope at `<base>/Leash/<userId>/…`, so the data the
 * old unscoped server showed becomes that user's isolated, supervised data.
 *
 *   npm run migrate:user              # → user "asaborodaniel", base ~ (LEASH_BASE)
 *   npm run migrate:user -- alice     # → user "alice"
 *
 * userId is minted by the SAME `slugifyUserId` the login route uses, so after migration you just
 * create that account (any password) and your data is already there. Moves are same-volume
 * renames (instant, xattr-safe — important for the qvac corestore). Idempotent: existing targets
 * are skipped, never overwritten.
 */
import { existsSync, mkdirSync, renameSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { slugifyUserId } from "../lib/leash/auth-core.ts";
import { leashBaseFrom, userScope } from "../lib/leash/scope.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const REPO_ROOT = join(here, "..", "..", "..");
const username = (process.argv[2] ?? "asaborodaniel").trim();
const base = process.env["LEASH_BASE"] ?? userInfo().homedir; // matches the app's "default"
const leashBase = leashBaseFrom(base);
const userId = slugifyUserId(username);
const scope = userScope(leashBase, userId);

const moved: string[] = [];
const skipped: string[] = [];

/** Same-volume rename; logs and records. Skips if the destination already exists. */
function move(src: string, dst: string, label: string): void {
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    skipped.push(`${label} (target exists: ${dst})`);
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  try {
    renameSync(src, dst); // same volume → instant, preserves xattrs (corestore device-file)
    moved.push(`${label}: ${src} → ${dst}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      // cross-volume (repo on external SSD, base on internal): copy then remove.
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      moved.push(`${label} (copied across volumes): ${src} → ${dst}`);
    } else {
      skipped.push(`${label} (rename failed: ${(e as Error).message})`);
    }
  }
}

console.log(`\nMigrating shared data → user "${username}" (userId ${userId})`);
console.log(`  base:      ${base}`);
console.log(`  scope dir: ${scope.scopeDir}\n`);

// Refuse to run while a qvac serve holds the corestore (would brick the move).
try {
  const pids = execFileSync("lsof", ["-ti", "TCP:11435", "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
  if (pids) {
    console.error("✗ A qvac serve is listening on :11435 — stop Model Serve (and any running dashboard) first, then re-run.");
    process.exit(1);
  }
} catch {
  /* lsof exit 1 = nothing listening = good */
}

mkdirSync(scope.dataDir, { recursive: true });
mkdirSync(dirname(scope.dbPath), { recursive: true });

// 1. repo data/  →  scope/data/   (everything except base-level / stale-auth files)
const DATA_DIR = join(REPO_ROOT, "data");
const EXCLUDE = new Set(["users.json", "active.json", "auth.json"]);
if (existsSync(DATA_DIR)) {
  for (const name of readdirSync(DATA_DIR)) {
    if (EXCLUDE.has(name) || name.endsWith(".tmp") || name.startsWith(".active.")) continue;
    move(join(DATA_DIR, name), join(scope.dataDir, name), `data/${name}`);
  }
}

// 2. the newsroom DB (default LEASH_DB_PATH fallback)  →  scope/db/newsroom.db
const dbDir = join(REPO_ROOT, "packages", "db", "prisma");
for (const suffix of ["", "-wal", "-shm"]) {
  move(join(dbDir, `newsroom.db${suffix}`), `${scope.dbPath}${suffix}`, `db/newsroom.db${suffix}`);
}

// 3. ~/.qvac (models, registry-corestore, rag-hyperdb, adapters)  →  scope/.qvac
move(join(homedir(), ".qvac"), scope.qvacDir, "~/.qvac (models)");

// 4. seed qvac.config into the scope so the serve resolves it (find-up from the scope dir)
for (const f of ["qvac.config.mjs", "qvac.config.base.json"]) {
  const realSrc = join(REPO_ROOT, f);
  if (existsSync(realSrc) && !existsSync(join(scope.scopeDir, f))) {
    try {
      execFileSync("cp", [realSrc, join(scope.scopeDir, f)]);
      moved.push(`config/${f} → ${join(scope.scopeDir, f)}`);
    } catch {
      /* non-fatal */
    }
  }
}

console.log("Moved:");
for (const m of moved) console.log(`  ✓ ${m}`);
if (skipped.length) {
  console.log("\nSkipped:");
  for (const s of skipped) console.log(`  • ${s}`);
}
console.log(`\nDone. Now run the app and create the account "${username}" (any password) — userId`);
console.log(`${userId} will match and your chats + models will be there.\n`);
if (statSync(scope.dataDir).isDirectory()) {
  const n = readdirSync(scope.dataDir).length;
  console.log(`(${scope.dataDir} now has ${n} entries.)`);
}
