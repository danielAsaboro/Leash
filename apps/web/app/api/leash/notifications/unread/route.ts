/** `GET /api/leash/notifications/unread` → { count } — polled by the rail bell badge. */
import { unreadCount } from "../../../../../lib/leash/notifications-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ count: await unreadCount() });
}
