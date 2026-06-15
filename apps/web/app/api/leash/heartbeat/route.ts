/**
 * `POST /api/leash/heartbeat` — the autonomous proactive turn.
 *
 * Server-to-server only: fired by leash-cron (kind: "heartbeat") or a leash-watch context switch,
 * NOT by a browser session. The middleware authorizes it with the shared internal token
 * (x-leash-internal header ↔ LEASH_INTERNAL_TOKEN), so it never bounces to /login. Runs one
 * heartbeat turn and returns the result for the cron run log.
 */
import { runHeartbeat } from "../../../../lib/leash/heartbeat.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let maxPerDay: number | undefined;
  try {
    const body = (await req.json()) as { maxPerDay?: number };
    if (body && typeof body.maxPerDay === "number") maxPerDay = body.maxPerDay;
  } catch {
    /* no body / not JSON — run with defaults */
  }
  const result = await runHeartbeat({ maxPerDay });
  return Response.json(result);
}
