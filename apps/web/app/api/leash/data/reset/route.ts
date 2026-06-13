import { NextResponse } from "next/server";
import { requestRespawn } from "../../../../../lib/leash/supervisor.ts";

export const runtime = "nodejs";

/**
 * `POST /api/leash/data/reset` — `{ scope: "user" | "factory" }`.
 *   · user    → wipe ONLY the current user's scope (data, db, models, config) and sign out.
 *   · factory → wipe the WHOLE Leash base (every user + shared models) → first-run setup.
 * The supervisor performs the deletion while the server is down (a running server can't delete
 * its own open DB/HOME), then respawns into BOOTSTRAP. Gated by middleware (valid session that
 * matches the active user), so only the signed-in user can reset their own / the whole install.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const { scope } = (await req.json().catch(() => ({}))) as { scope?: unknown };
  if (scope !== "user" && scope !== "factory")
    return NextResponse.json({ error: 'scope must be "user" or "factory"' }, { status: 400 });

  const activeUser = process.env["LEASH_ACTIVE_USER"] ?? null;
  if (scope === "user" && !activeUser)
    return NextResponse.json({ error: "no active user to reset" }, { status: 409 });

  if (scope === "factory") requestRespawn({ userId: null, op: "reset-factory" });
  else requestRespawn({ userId: null, op: "reset-user", target: activeUser as string });
  return NextResponse.json({ ok: true });
}
