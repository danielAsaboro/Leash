/**
 * `/services` — the ops console. One card per SERVICE (the managed system around a
 * daemon): Model Serve · Screen Watcher · Newsroom · Cron. Each card: live state,
 * start/stop/restart, log tail. The Cron card hosts the Schedules CRUD — the
 * scheduler's configuration is part of its service. Tasks the services produce live
 * on /tasks; this page is about the daemons.
 */
import Link from "next/link";
import { TelescopeIcon } from "lucide-react";
import { servicesStatus } from "../../lib/leash/services.ts";
import { listSchedules, cronState, cronRuns } from "../../lib/leash/schedules-store.ts";
import { DashShell } from "../../components/dash.tsx";
import { ServiceCard } from "../../components/ServiceCard.tsx";
import { SchedulesSection } from "../../components/SchedulesSection.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const [services, schedules, state, runs] = await Promise.all([servicesStatus(), listSchedules(), cronState(), cronRuns()]);

  return (
    <DashShell kicker="Leash · Ops" title="Services" lede="The daemons that run your exocortex — supervised, scheduled, honest about their state.">
      <LiveRefresh seconds={5} />
      <div className="flex flex-col gap-5">
        {services.map((s) => (
          <ServiceCard key={s.name} service={s}>
            {s.name === "mcp-cron" && <SchedulesSection schedules={schedules} state={state} runs={runs} />}
            {s.name === "hypha" && (
              <p className="kicker mt-3" style={{ color: "var(--color-faint)" }}>
                Mesh peers, model sharing & device pairing live in{" "}
                <Link href="/settings?tab=devices" className="underline transition-opacity hover:opacity-70" style={{ color: "var(--color-sage-deep)" }}>
                  Settings → Devices
                </Link>
                .
              </p>
            )}
          </ServiceCard>
        ))}

        {/* Research — detached background runs (gather → read → synthesize), not a supervised daemon. */}
        <section className="border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="kicker kicker-sage">Research</span>
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
            <Link href="/services/research" title="Open research" aria-label="Open research" className="inline-flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100" style={{ color: "var(--color-sage-deep)" }}>
              <TelescopeIcon size={16} />
            </Link>
          </div>
          <p className="kicker mt-2" style={{ color: "var(--color-faint)" }}>
            Deep research runs — detached background jobs that gather, read, and synthesize live web sources into cited reports.
          </p>
        </section>
      </div>
    </DashShell>
  );
}
