/**
 * `/home` — the dashboard overview: every subsystem's live state on one page.
 * All real reads (serve probe, Prisma daemon state, watcher mtime, task store,
 * chat store, model-cache scan); refreshes every 5s like Mission Control.
 */
import Link from "next/link";
import { stat } from "node:fs/promises";
import { prisma } from "../../lib/db.ts";
import { liveModels, modelsDiskUsage, modelsDirLocation, fmtBytes } from "../../lib/leash/models.ts";
import { ACTIVITY_LOG } from "../../lib/leash/graph.ts";
import { taskCounts } from "../../lib/leash/tasks-store.ts";
import { listChats } from "../../lib/leash/chat-store.ts";
import { DashShell, DashCard, Stat, Row, StateBadge } from "../../components/dash.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";

export const dynamic = "force-dynamic";

function fmtTime(d: Date | number | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function relTime(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The watcher's freshness from the activity log's mtime (null = no log yet). */
async function watcherMtime(): Promise<number | null> {
  try {
    return (await stat(ACTIVITY_LOG)).mtimeMs;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const [live, disk, diskWhere, daemon, watchMs, tasks, chats] = await Promise.all([
    liveModels(),
    modelsDiskUsage(),
    modelsDirLocation(),
    prisma.daemonState.findUnique({ where: { id: 1 } }).catch(() => null),
    watcherMtime(),
    taskCounts(),
    listChats(),
  ]);
  const recentChats = chats.filter((c) => c.messageCount > 0).slice(0, 5);
  // Watcher observes every ~2 min when running; >10 min stale ⇒ treat as stopped.
  const watcherFresh = watchMs !== null && Date.now() - watchMs < 10 * 60 * 1000;

  return (
    <DashShell kicker="Leash · Overview" title="Home" lede="Your exocortex at a glance — serve, newsroom, watcher, TODOs, models.">
      <LiveRefresh seconds={5} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Model serve */}
        <DashCard
          title="Model Serve"
          action={
            <Link href="/brain?tab=models" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-sage-deep)" }}>
              Manage →
            </Link>
          }
        >
          <StateBadge ok={live.up} label={live.up ? "Ready" : "Offline"} />
          {live.up ? (
            <ul className="mt-3">
              {live.ready.map((id) => (
                <li key={id} className="border-b py-1.5 last:border-b-0" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                  {id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="kicker mt-3" style={{ color: "var(--color-faint)" }}>
              qvac serve isn&rsquo;t answering on :11435 — start it from Brain → Models or `npm run qvac`.
            </p>
          )}
        </DashCard>

        {/* Newsroom daemon */}
        <DashCard
          title="Newsroom"
          action={
            <Link href="/services" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-sage-deep)" }}>
              Services →
            </Link>
          }
        >
          <StateBadge ok={daemon ? daemon.status === "RUNNING" : null} label={daemon?.status ?? "No state yet"} />
          <div className="mt-3">
            <Row label="Last discovery" value={fmtTime(daemon?.lastDiscoveryAt)} />
            <Row label="Next check" value={fmtTime(daemon?.nextCheckAt)} />
            <Row label="Cadence" value={`${daemon?.cadenceMin ?? 60} min`} />
          </div>
        </DashCard>

        {/* Screen watcher */}
        <DashCard title="Screen Watcher">
          <StateBadge ok={watchMs === null ? null : watcherFresh} label={watchMs === null ? "Never ran" : watcherFresh ? "Watching" : "Stale"} />
          <div className="mt-3">
            <Row label="Last observation" value={watchMs === null ? "—" : relTime(watchMs)} />
          </div>
          {watchMs === null && (
            <p className="kicker mt-3" style={{ color: "var(--color-faint)" }}>
              Start it with `npm run watch` (needs Screen Recording permission).
            </p>
          )}
        </DashCard>

        {/* Activity */}
        <DashCard
          title="Activity"
          action={
            <Link href="/activity" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-sage-deep)" }}>
              All activity →
            </Link>
          }
        >
          <div className="flex gap-8">
            <Stat label="Open TODOs" value={tasks.open} accent={tasks.open > 0} />
            <Stat label="In progress" value={tasks.inProgress} />
            <Stat label="Done" value={tasks.done} />
          </div>
        </DashCard>

        {/* Recent chats */}
        <DashCard
          title="Recent Chats"
          action={
            <Link href="/chat" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-sage-deep)" }}>
              Open chat →
            </Link>
          }
        >
          {recentChats.length === 0 ? (
            <p className="kicker" style={{ color: "var(--color-faint)" }}>
              No conversations yet.
            </p>
          ) : (
            <ul>
              {recentChats.map((c) => (
                <li key={c.id} className="border-b last:border-b-0" style={{ borderColor: "var(--color-rule)" }}>
                  <Link href={`/chat/${c.id}`} className="flex items-baseline justify-between gap-3 py-1.5 transition-opacity hover:opacity-60">
                    <span className="truncate" style={{ fontFamily: "var(--font-body)", fontSize: "0.9rem" }}>
                      {c.title}
                    </span>
                    <span className="kicker shrink-0" style={{ color: "var(--color-faint)" }} suppressHydrationWarning>
                      {relTime(c.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DashCard>

        {/* Model disk */}
        <DashCard
          title="Model Disk"
          action={
            <Link href="/brain?tab=models" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-sage-deep)" }}>
              Inventory →
            </Link>
          }
        >
          <div className="flex gap-8">
            <Stat label="On disk" value={fmtBytes(disk.totalBytes)} />
            <Stat label="Files" value={disk.files.length} />
          </div>
          <p className="kicker mt-3" style={{ color: "var(--color-faint)" }}>
            ~/.qvac/models ({diskWhere})
          </p>
        </DashCard>
      </div>
    </DashShell>
  );
}
