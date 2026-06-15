/**
 * `POST /api/leash/notifications/[id]` { action } — run an inline notification action:
 *   read | snooze (ms?) | dismiss | approve | always_auto
 * "always_auto" pins this proposal's tier to auto via the heartbeat override store, so the same
 * recurring nudge stops interrupting; "approve" acknowledges an ask-tier suggestion.
 */
import { markRead, snooze, dismiss, getNotification } from "../../../../../lib/leash/notifications-store.ts";
import { setOverride } from "../../../../../lib/leash/heartbeat-state.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SNOOZE_MS = 60 * 60 * 1000; // 1h

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  let body: { action?: string; ms?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  switch (body.action) {
    case "read": {
      const n = await markRead(id);
      return n ? Response.json({ notification: n }) : Response.json({ error: "not found" }, { status: 404 });
    }
    case "snooze": {
      const n = await snooze(id, typeof body.ms === "number" ? body.ms : DEFAULT_SNOOZE_MS);
      return n ? Response.json({ notification: n }) : Response.json({ error: "not found" }, { status: 404 });
    }
    case "dismiss": {
      const n = await dismiss(id);
      return n ? Response.json({ notification: n }) : Response.json({ error: "not found" }, { status: 404 });
    }
    case "approve": {
      // Acknowledge an ask-tier suggestion (the body describes what the user chose to do).
      const n = await markRead(id);
      return n ? Response.json({ notification: n }) : Response.json({ error: "not found" }, { status: 404 });
    }
    case "always_auto": {
      const existing = await getNotification(id);
      if (!existing) return Response.json({ error: "not found" }, { status: 404 });
      await setOverride(existing.body, "auto"); // pin: future matching proposals stop interrupting
      const n = await dismiss(id);
      return Response.json({ notification: n });
    }
    default:
      return Response.json({ error: "action must be read | snooze | dismiss | approve | always_auto" }, { status: 400 });
  }
}
