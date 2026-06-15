/**
 * `/notifications` — the proactive assistant's feed. Every heartbeat alert lands here with its
 * explainable "why" + tier and inline actions. The rail bell badge mirrors the unread count.
 */
import { listNotifications } from "../../lib/leash/notifications-store.ts";
import { DashShell } from "../../components/dash.tsx";
import { NotificationsPanel } from "../../components/NotificationsPanel.tsx";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const notifications = await listNotifications({ limit: 50 });
  return (
    <DashShell kicker="Leash · Proactive" title="Notifications" lede="What the assistant noticed for you — each with why it matters and what you can do about it.">
      <NotificationsPanel initial={notifications} />
    </DashShell>
  );
}
