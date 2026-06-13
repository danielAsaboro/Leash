import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../../lib/leash/auth.ts";
import { requestRespawn } from "../../../../../lib/leash/supervisor.ts";

export const runtime = "nodejs";

/** Clear this browser's cookie and drop the server back to BOOTSTRAP (no active user).
 *  We do NOT rotate the user's secret here — that would invalidate the user's sessions on
 *  their other devices; a logout is a local sign-out. */
export async function POST(): Promise<NextResponse> {
  requestRespawn({ userId: null });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
