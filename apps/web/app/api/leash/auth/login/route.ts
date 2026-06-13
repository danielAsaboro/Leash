import { NextResponse } from "next/server";
import { verifyLogin, signSessionFor, SESSION_COOKIE, SESSION_MAX_AGE } from "../../../../../lib/leash/auth.ts";
import { requestRespawn } from "../../../../../lib/leash/supervisor.ts";

export const runtime = "nodejs";

/** Verify username+password → set the session cookie and return the userId to activate. */
export async function POST(req: Request): Promise<NextResponse> {
  const { username, password } = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string")
    return NextResponse.json({ error: "username and password are required" }, { status: 400 });
  const r = verifyLogin(username, password);
  if (!r) return NextResponse.json({ error: "incorrect username or password" }, { status: 401 });
  requestRespawn({ userId: r.userId }); // respawn scoped to this user
  const res = NextResponse.json({ ok: true, switchTo: r.userId });
  res.cookies.set(SESSION_COOKIE, signSessionFor(r.userId), { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
