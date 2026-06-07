import Link from "next/link";
import { getMissionControl, getStuckArticles } from "../../lib/queries.ts";
import { sectionKicker } from "../../lib/ui.ts";
import { StatusDot } from "../../components/StatusDot.tsx";
import { StageTracker } from "../../components/StageTracker.tsx";
import { CountdownTimer } from "../../components/CountdownTimer.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";
import { MissionControlActions } from "../../components/MissionControlActions.tsx";

export const dynamic = "force-dynamic";

function fmt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "3m" / "2h" / "1d" since a timestamp (how long a story has sat untouched). */
function ago(d: Date | string): string {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
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
  const [{ state, counts, active, recentRuns }, stuck] = await Promise.all([getMissionControl(), getStuckArticles()]);
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

        {/* In production — drill-down: every mid-pipeline story, stalest first, with WHY
            it's stuck (latest failed run) and a gated Re-queue (full pipeline re-run). */}
        <section className="mt-8 border p-6" style={{ borderColor: "var(--color-control-line)", background: "var(--color-control-2)" }}>
          <div className="mb-4 flex items-center gap-3">
            <span className="kicker kicker-sage" style={{ color: "var(--color-glow)" }}>
              In Production
            </span>
            <span className="h-px flex-1" style={{ background: "var(--color-control-line)" }} />
            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              {stuck.length} {stuck.length === 1 ? "story" : "stories"} mid-pipeline
            </span>
          </div>

          {stuck.length === 0 ? (
            <p className="kicker" style={{ color: "var(--color-faint)" }}>
              Nothing mid-pipeline — stories are either queued or published.
            </p>
          ) : (
            <ul>
              {stuck.map((s) => {
                // Eligibility mirrors the SERVER gate exactly (stalled >5 min). The Active
                // Assignment card's pick is a display fallback, not a daemon lock — a row
                // only reads "being worked" while its updatedAt is actually fresh.
                const isActive = s.id === active?.id && !s.stalled;
                const eligible = s.stalled;
                const reason = isActive ? "active assignment — being worked now" : !s.stalled ? `touched ${ago(s.updatedAt)} ago — re-queue unlocks after 5 min idle` : "";
                return (
                  <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 border-b py-3.5" style={{ borderColor: "var(--color-control-line)" }}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="kicker px-2 py-0.5" style={{ background: "var(--color-control-line)", color: "var(--color-cream)" }}>
                          {sectionKicker(s.section, s.origin)}
                        </span>
                        <span className="kicker" style={{ color: s.stalled ? "var(--color-brick)" : "var(--color-glow)" }}>
                          {s.stage}
                        </span>
                        <span className="kicker" style={{ color: "var(--color-faint)" }} suppressHydrationWarning>
                          {s.stalled ? `stuck ${ago(s.updatedAt)}` : `updated ${ago(s.updatedAt)} ago`}
                        </span>
                      </div>
                      <p className="mt-1.5" style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "1.05rem", color: "var(--color-cream)" }}>
                        {s.headline}
                      </p>
                      {s.failure ? (
                        <p className="kicker mt-1" style={{ color: "var(--color-brick)" }}>
                          ✗ {s.failure.kind} failed {fmt(s.failure.startedAt)}
                          {s.failure.detail ? ` — ${s.failure.detail.slice(0, 200)}` : ""}
                        </p>
                      ) : (
                        s.stalled && (
                          <p className="kicker mt-1" style={{ color: "var(--color-faint)" }}>
                            No failed run recorded — the daemon may have been stopped mid-story.
                          </p>
                        )
                      )}
                    </div>
                    <MissionControlActions id={s.id} headline={s.headline} eligible={eligible} reason={reason} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
