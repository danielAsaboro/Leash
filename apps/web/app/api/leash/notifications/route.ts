/**
 * `GET  /api/leash/notifications`  → { notifications, unreadCount }   (feed; ?unread=1, ?limit=N)
 * `POST /api/leash/notifications`  { tier, title, body, why?, type? } → create one (manual/testing)
 * The proactive assistant's voice. The heartbeat writes here directly via the store; this route
 * serves the in-app feed and a manual create path.
 */
import { listNotifications, unreadCount, addNotification } from "../../../../lib/leash/notifications-store.ts";
import type { Tier } from "../../../../lib/leash/classify.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Number(url.searchParams.get("limit")) || undefined;
  const [notifications, unread] = await Promise.all([listNotifications({ unreadOnly, limit }), unreadCount()]);
  return Response.json({ notifications, unreadCount: unread });
}

export async function POST(req: Request): Promise<Response> {
  let body: { tier?: Tier; title?: string; body?: string; why?: string; type?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.title?.trim() || !body.body?.trim()) return Response.json({ error: "title and body are required" }, { status: 400 });
  const tier: Tier = body.tier === "auto" || body.tier === "ask" ? body.tier : "notify";
  const notification = await addNotification({ tier, title: body.title, body: body.body, why: body.why, type: body.type as never });
  return Response.json({ notification }, { status: 201 });
}
