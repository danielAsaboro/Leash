import "server-only";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The web↔supervisor handshake. The supervisor (`server-launch.mjs`, which the desktop app
 * spawns too) owns the process lifecycle: it spawns the Next server scoped to the active user,
 * and on child EXIT re-reads `active.json` and respawns accordingly. So to switch user / log out
 * / reset, a route writes `active.json` then exits — the supervisor reacts to the exit (reliable,
 * cross-platform) rather than watching the file. There is no unsupervised path: every server is
 * launched by the supervisor.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = process.env["LEASH_BASE_DIR"] ?? join(here, "..", "..", "..", "..", "data");
const ACTIVE_FILE = join(BASE_DIR, "active.json");

export type PendingOp = "reset-user" | "reset-factory";

export interface ActiveState {
  /** The user to scope to after respawn; null → bootstrap (logged out / first run). */
  userId: string | null;
  /** A destructive op for the supervisor to perform (while the server is down) before respawn. */
  op?: PendingOp;
  /** For `reset-user`: which userId's scope dir to wipe (the server can't delete its own open DB). */
  target?: string;
}

/** Atomically record the next active state for the supervisor to read on child exit. */
export function writeActive(state: ActiveState): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
  const tmp = join(BASE_DIR, `.active.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, ACTIVE_FILE);
}

/**
 * Trigger a scoped respawn: write `active.json`, then exit shortly after the HTTP response has
 * flushed so the supervisor brings the server back up in the new scope.
 */
export function requestRespawn(state: ActiveState): void {
  writeActive(state);
  setTimeout(() => process.exit(0), 500);
}
