import { randomBytes, scryptSync, createHmac, createHash, timingSafeEqual } from "node:crypto";

/** One account in the base-level registry (`<LEASH_BASE_DIR>/users.json`). */
export interface UserEntry {
  username: string;
  /** Stable, path-safe id = `<slug>-<hash8>`; the on-disk scope dir name. */
  userId: string;
  salt: string;
  passwordHash: string;
  /** Per-user HMAC secret — a logout/reset rotates only THIS user's sessions. */
  sessionSecret: string;
}

const hash = (pw: string, salt: string): Buffer => scryptSync(pw, salt, 64);
const hmac = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

/**
 * username → stable, path-safe userId (`<slug>-<hash8>`). MUST stay byte-identical to the
 * desktop helper `slugifyUserId` in apps/desktop/src/main/install-paths.ts (plain sha256),
 * so a userId minted here resolves to the same on-disk scope the supervisor creates.
 */
export function slugifyUserId(username: string): string {
  const norm = username.trim().toLowerCase();
  const slug = norm.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "user";
  const h = createHash("sha256").update(norm).digest("hex").slice(0, 8);
  return `${slug}-${h}`;
}

export function makeUser(username: string, userId: string, pw: string): UserEntry {
  if (pw.length < 6) throw new Error("password too short (min 6)");
  const salt = randomBytes(16).toString("hex");
  return { username, userId, salt, passwordHash: hash(pw, salt).toString("hex"), sessionSecret: randomBytes(32).toString("hex") };
}

/** Set a fresh password (new salt + hash). Leaves sessionSecret alone — the caller decides
 *  whether to also rotate (a password change should, to drop other devices' sessions). */
export function setPassword(u: UserEntry, newPw: string): UserEntry {
  if (newPw.length < 6) throw new Error("password too short (min 6)");
  const salt = randomBytes(16).toString("hex");
  return { ...u, salt, passwordHash: hash(newPw, salt).toString("hex") };
}

export function verifyPassword(u: UserEntry, pw: string): boolean {
  const got = hash(pw, u.salt);
  const want = Buffer.from(u.passwordHash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function rotate(u: UserEntry): UserEntry {
  return { ...u, sessionSecret: randomBytes(32).toString("hex") };
}

/** Session token = `${userId}.${iat}.${hmac(userId.iat)}`. userId carries no dot, so split is unambiguous. */
export function signSession(u: UserEntry, nowMs: number): string {
  const payload = `${u.userId}.${nowMs}`;
  return `${payload}.${hmac(payload, u.sessionSecret)}`;
}

export interface SessionInfo {
  userId: string;
  iat: number;
}

/** Decode (WITHOUT verifying) to learn which user's secret to look up. null if malformed. */
export function parseSession(token: string | undefined): SessionInfo | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, iat] = parts;
  if (!userId || !/^\d+$/.test(iat)) return null;
  return { userId, iat: Number(iat) };
}

/** Verify a token against a SPECIFIC user's secret (caller looks the user up by parseSession). */
export function verifySession(u: UserEntry, token: string | undefined, nowMs: number): boolean {
  const info = parseSession(token);
  if (!info || info.userId !== u.userId) return false;
  if (info.iat > nowMs + 60_000) return false;
  const want = hmac(`${u.userId}.${info.iat}`, u.sessionSecret);
  const sig = (token as string).split(".")[2];
  let sb: Buffer, wb: Buffer;
  try {
    sb = Buffer.from(sig, "hex");
    wb = Buffer.from(want, "hex");
  } catch {
    return false;
  }
  return sb.length === wb.length && timingSafeEqual(sb, wb);
}
