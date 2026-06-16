import { NextResponse } from "next/server";
import { changePassword, signSessionFor, SESSION_COOKIE, SESSION_MAX_AGE } from "../../../../../lib/leash/auth.ts";

export const runtime = "nodejs";

/**
 * `POST /api/leash/account/password` — `{ currentPassword, newPassword }`.
 * Change the signed-in user's password. NOT under `/api/leash/auth/` (that prefix is public for
 * the pre-login handshake) — this lives under `/account/` so middleware gates it: only a valid
 * session matching the active user reaches here. Verifies the current password, sets the new one,
 * rotates the session secret (dropping other devices), and re-issues THIS session's cookie so the
 * caller stays signed in.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const activeUser = process.env["LEASH_ACTIVE_USER"] ?? null;
  if (!activeUser) return NextResponse.json({ error: "no active user" }, { status: 401 });
  const { currentPassword, newPassword } = (await req.json().catch(() => ({}))) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  if (typeof currentPassword !== "string" || typeof newPassword !== "string")
    return NextResponse.json({ error: "currentPassword and newPassword are required" }, { status: 400 });
  const r = await changePassword(activeUser, currentPassword, newPassword);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSessionFor(activeUser), { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
