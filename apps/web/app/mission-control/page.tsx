import Link from "next/link";
import { getMissionControl } from "../../lib/queries.ts";
import { sectionKicker } from "../../lib/ui.ts";
import { StatusDot } from "../../components/StatusDot.tsx";
import { StageTracker } from "../../components/StageTracker.tsx";
import { CountdownTimer } from "../../components/CountdownTimer.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";

export const dynamic = "force-dynamic";

function fmt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function CountCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-2 border p-5" style={{ borderColor: "var(--color-control-line)", background: "var(--color-control-2)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 900,
          fontSize: "3.2rem",
          lineHeight: 1,
          color: accent ? "var(--color-glow)" : "var(--color-cream)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Telemetry({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b py-2.5" style={{ borderColor: "var(--color-control-line)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        {label}
      </span>
      <span className="kicker" style={{ color: "var(--color-cream)", letterSpacing: "0.08em" }}>
        {value}
      </span>
    </div>
  );
}

export default async function MissionControl() {
  const { state, counts, active, recentRuns } = await getMissionControl();
  const status = state?.status ?? "STOPPED";
  const masthead = state?.masthead ?? "The Understory";

  return (
    <div className="min-h-screen" style={{ background: "var(--color-control)", color: "var(--color-cream)" }}>
      <LiveRefresh seconds={5} />

      {/* Banner */}
      <div className="border-b" style={{ borderColor: "var(--color-control-line)", background: "#000" }}>
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-4">
          <div className="flex items-baseline gap-3">
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "1.35rem", color: "var(--color-cream)" }}>
              {masthead}
            </span>
            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              Mission Control
            </span>
          </div>
          <StatusDot status={status} dark />
        </div>
      </div>

      <main className="mx-auto max-w-[1180px] px-5 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "1.6rem" }}>The Newsroom Floor</h1>
          <Link href="/" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-glow)" }}>
            ← Today&rsquo;s edition
          </Link>
        </div>

        {/* Count cards */}
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <CountCard label="Queued" value={counts.queued} />
          <CountCard label="In Progress" value={counts.inProgress} accent={counts.inProgress > 0} />
          <CountCard label="Needs Reporting" value={counts.needsReporting} />
          <CountCard label="Published" value={counts.published} accent />
        </section>

        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Active assignment */}
          <section className="border p-6" style={{ borderColor: "var(--color-control-line)", background: "var(--color-control-2)" }}>
            <div className="mb-4 flex items-center gap-3">
              <span className="kicker kicker-sage" style={{ color: "var(--color-glow)" }}>
                Active Assignment
              </span>
              <span className="h-px flex-1" style={{ background: "var(--color-control-line)" }} />
            </div>

            {active ? (
              <>
                <div className="flex items-center gap-3">
                  <span
                    className="kicker px-2 py-1"
                    style={{ background: "var(--color-control-line)", color: "var(--color-cream)" }}
                  >
                    {sectionKicker(active.section, active.origin)}
                  </span>
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>
                    Started {fmt(active.startedAt)}
                  </span>
                </div>
                <h2 className="mt-4" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.7rem", lineHeight: 1.08, color: "var(--color-cream)" }}>
                  {active.headline}
                </h2>
                {active.dek && (
                  <p className="mt-2 italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>
                    {active.dek}
                  </p>
                )}
                <div className="mt-6">
                  <StageTracker stage={active.stage} dark />
                </div>
                {active.dossier && (
                  <Link
                    href={`/${active.date}/${active.slug}/dossier`}
                    className="kicker mt-6 inline-block transition-opacity hover:opacity-70"
                    style={{ color: "var(--color-glow)" }}
                  >
                    Open dossier →
                  </Link>
                )}
              </>
            ) : (
              <p className="kicker" style={{ color: "var(--color-faint)" }}>
                No active assignment — the desk is idle. Next discovery will pull new leads.
              </p>
            )}
          </section>

          {/* Daemon telemetry */}
          <section className="border p-6" style={{ borderColor: "var(--color-control-line)", background: "var(--color-control-2)" }}>
            <span className="kicker kicker-sage" style={{ color: "var(--color-glow)" }}>
              Daemon Telemetry
            </span>

            <div className="my-6 text-center">
              <p className="kicker" style={{ color: "var(--color-faint)" }}>
                Next Discovery
              </p>
              <p className="mt-2" style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "2.8rem", letterSpacing: "0.04em" }}>
                <CountdownTimer target={state?.nextCheckAt ? new Date(state.nextCheckAt).toISOString() : null} />
              </p>
            </div>

            <Telemetry label="Started" value={fmt(state?.startedAt)} />
            <Telemetry label="Last Discovery" value={fmt(state?.lastDiscoveryAt)} />
            <Telemetry label="Next Check" value={fmt(state?.nextCheckAt)} />
            <Telemetry label="Cadence" value={`${state?.cadenceMin ?? 60} min`} />

            {/* Run feed */}
            <div className="mt-6">
              <span className="kicker" style={{ color: "var(--color-faint)" }}>
                Recent Runs
              </span>
              <ul className="mt-2 space-y-1.5">
                {recentRuns.map((r) => {
                  const dur = r.finishedAt ? ((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(1) + "s" : "…";
                  return (
                    <li key={r.id} className="flex items-center justify-between" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
                      <span style={{ color: r.ok ? "var(--color-glow)" : "var(--color-brick)" }}>
                        {r.ok ? "✓" : "✗"} {r.kind}
                      </span>
                      <span style={{ color: "var(--color-faint)" }}>{dur}</span>
                    </li>
                  );
                })}
                {recentRuns.length === 0 && (
                  <li className="kicker" style={{ color: "var(--color-faint)" }}>
                    No runs yet.
                  </li>
                )}
              </ul>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
