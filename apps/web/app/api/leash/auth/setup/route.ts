import { NextResponse } from "next/server";
import { createUser, signSessionFor, SESSION_COOKIE, SESSION_MAX_AGE } from "../../../../../lib/leash/auth.ts";
import { requestRespawn } from "../../../../../lib/leash/supervisor.ts";

export const runtime = "nodejs";

/** Create an account (first run, or an additional isolated user). Sets the session cookie and
 *  returns the userId the client should activate. New accounts are fully isolated, so this is
 *  open at the gate exactly like /login. */
export async function POST(req: Request): Promise<NextResponse> {
  const { username, password } = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string")
    return NextResponse.json({ error: "username and password are required" }, { status: 400 });
  const r = await createUser(username, password);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
  requestRespawn({ userId: r.userId }); // respawn scoped to the new user
  const res = NextResponse.json({ ok: true, switchTo: r.userId });
  res.cookies.set(SESSION_COOKIE, signSessionFor(r.userId), { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
