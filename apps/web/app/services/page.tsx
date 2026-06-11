/**
 * `/services` — the ops console. One card per SERVICE (the managed system around a
 * daemon): Model Serve · Screen Watcher · Newsroom · Cron. Each card: live state,
 * start/stop/restart, log tail. The Cron card hosts the Schedules CRUD — the
 * scheduler's configuration is part of its service. Tasks the services produce live
 * on /tasks; this page is about the daemons.
 */
import { servicesStatus } from "../../lib/leash/services.ts";
import { listSchedules, cronState, cronRuns } from "../../lib/leash/schedules-store.ts";
import { listSecretStatus } from "../../lib/leash/vault.ts";
import { meshStatus } from "../../lib/leash/hypha.ts";
import { DashShell } from "../../components/dash.tsx";
import { ServiceCard } from "../../components/ServiceCard.tsx";
import { SchedulesSection } from "../../components/SchedulesSection.tsx";
import { SecretsCard } from "../../components/SecretsCard.tsx";
import { HyphaPeersSection } from "../../components/HyphaPeersSection.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const [services, schedules, state, runs, mesh] = await Promise.all([servicesStatus(), listSchedules(), cronState(), cronRuns(), meshStatus()]);

  return (
    <DashShell kicker="Leash · Ops" title="Services" lede="The daemons that run your exocortex — supervised, scheduled, honest about their state.">
      <LiveRefresh seconds={5} />
      <div className="flex flex-col gap-5">
        {services.map((s) => (
          <ServiceCard key={s.name} service={s}>
            {s.name === "leash-cron" && <SchedulesSection schedules={schedules} state={state} runs={runs} />}
            {s.name === "hypha" && <HyphaPeersSection status={mesh} />}
          </ServiceCard>
        ))}
        <SecretsCard secrets={listSecretStatus()} />
      </div>
    </DashShell>
  );
}
