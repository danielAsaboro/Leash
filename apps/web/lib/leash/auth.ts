import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeUser,
  setPassword,
  verifyPassword as vp,
  signSession as sign,
  verifySession as vs,
  parseSession,
  rotate,
  slugifyUserId,
  type UserEntry,
} from "./auth-core.ts";

/**
 * Multi-user auth, registry-based. The registry (`users.json`) lives at the BASE level
 * (`LEASH_BASE_DIR`), NOT inside any user's data dir — so login/create-account work in the
 * pre-login (BOOTSTRAP) server before any user is scoped. Per-user DATA/DB/models are scoped
 * by the supervisor via the process env; this module only owns identity.
 *
 * A successful login/setup returns the userId to the client, which asks the supervisor
 * (Electron main / web launcher) to make that user ACTIVE — respawning the server scoped to
 * them. This module never writes `active.json`; it doesn't own process lifecycle.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** lib/leash → repo root → data/ — the dev fallback when no supervisor set LEASH_BASE_DIR. */
const BASE_DIR = process.env["LEASH_BASE_DIR"] ?? join(here, "..", "..", "..", "..", "data");
const REGISTRY_FILE = join(BASE_DIR, "users.json");

export const SESSION_COOKIE = "leash_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

interface Registry {
  version: 1;
  users: UserEntry[];
}

function readRegistry(): Registry {
  try {
    const r = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    if (r?.version === 1 && Array.isArray(r.users)) return r as Registry;
  } catch {
    /* missing/garbled → empty */
  }
  return { version: 1, users: [] };
}

function writeRegistry(r: Registry): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
  const tmp = join(BASE_DIR, `.users.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  renameSync(tmp, REGISTRY_FILE); // atomic
}

/** Serialize read-modify-write so two concurrent create/rotate calls never lose an entry. */
let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => T): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => undefined, () => undefined);
  return run;
}

export function authEnabled(): boolean {
  return process.env["LEASH_AUTH"] !== "0";
}

/** The dashboard is gated until at least one account exists. */
export function isConfigured(): boolean {
  return readRegistry().users.length > 0;
}

/** Public-safe roster (no secrets) — for a future user-switcher UI. */
export function listUsers(): { username: string; userId: string }[] {
  return readRegistry().users.map((u) => ({ username: u.username, userId: u.userId }));
}

function findById(users: UserEntry[], userId: string): UserEntry | undefined {
  return users.find((u) => u.userId === userId);
}
function findByName(users: UserEntry[], username: string): UserEntry | undefined {
  const n = username.trim().toLowerCase();
  return users.find((u) => u.username.trim().toLowerCase() === n);
}

/** Create an account. Returns the userId, or an error string (duplicate / bad input). */
export function createUser(username: string, pw: string): Promise<{ userId: string } | { error: string }> {
  const name = username.trim();
  if (name.length < 1 || name.length > 64) return Promise.resolve({ error: "username must be 1–64 characters" });
  if (pw.length < 6) return Promise.resolve({ error: "password must be at least 6 characters" });
  const userId = slugifyUserId(name);
  return withLock(() => {
    const reg = readRegistry();
    if (findByName(reg.users, name)) return { error: "that username is taken" };
    if (findById(reg.users, userId)) return { error: "that username is taken" };
    reg.users.push(makeUser(name, userId, pw));
    writeRegistry(reg);
    return { userId };
  });
}

/** Verify username+password → userId, or null. */
export function verifyLogin(username: string, pw: string): { userId: string } | null {
  const u = findByName(readRegistry().users, username);
  return u && vp(u, pw) ? { userId: u.userId } : null;
}

/** Sign a session token for a userId (after a verified login/create). */
export function signSessionFor(userId: string): string {
  const u = findById(readRegistry().users, userId);
  if (!u) throw new Error("no such user");
  return sign(u, Date.now());
}

/** Verify a cookie → the userId it authenticates, or null. */
export function verifySession(token: string | undefined): string | null {
  const info = parseSession(token);
  if (!info) return null;
  const u = findById(readRegistry().users, info.userId);
  return u && vs(u, token, Date.now()) ? u.userId : null;
}

/** Change a user's password: verify the current one, set a fresh hash, and rotate the session
 *  secret so OTHER devices' sessions drop (the caller re-issues this session's cookie). Returns
 *  ok, or an error string (wrong current password / too short / unknown user). */
export function changePassword(userId: string, currentPw: string, newPw: string): Promise<{ ok: true } | { error: string }> {
  if (newPw.length < 6) return Promise.resolve({ error: "new password must be at least 6 characters" });
  return withLock(() => {
    const reg = readRegistry();
    const i = reg.users.findIndex((u) => u.userId === userId);
    if (i < 0) return { error: "no such user" };
    const u = reg.users[i] as UserEntry;
    if (!vp(u, currentPw)) return { error: "current password is incorrect" };
    reg.users[i] = rotate(setPassword(u, newPw));
    writeRegistry(reg);
    return { ok: true as const };
  });
}

/** Rotate one user's secret (invalidates only THAT user's existing sessions). */
export function rotateUser(userId: string): void {
  return void withLock(() => {
    const reg = readRegistry();
    const i = reg.users.findIndex((u) => u.userId === userId);
    if (i >= 0) {
      reg.users[i] = rotate(reg.users[i] as UserEntry);
      writeRegistry(reg);
    }
  });
}
