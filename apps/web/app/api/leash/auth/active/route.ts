import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public readiness probe for the login/switch handshake: who is this server scoped to?
 *  The client polls this after triggering a respawn — connection errors mean "still
 *  switching", and a matching activeUserId means the new scope is up. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ activeUserId: process.env["LEASH_ACTIVE_USER"] ?? null, ready: true });
}
