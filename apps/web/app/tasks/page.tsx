/**
 * `/tasks` — every TASK (a unit of work that runs, finishes, exits), grouped by
 * producer:
 *   · Mine     — human to-dos (user / assistant / dream / cron created)
 *   · Newsroom — pipeline articles as tasks (stage = task state)
 *   · Runs     — executed work records from the services (newsroom runs + cron runs)
 * Daemon/process management lives on /services — this page is about the work.
 */
import Link from "next/link";
import { listTasks, TASK_STATUSES, type TaskStatus, type TaskSource } from "../../lib/leash/tasks-store.ts";
import { getPipeline, getPipelineFacets, getDaemons } from "../../lib/queries.ts";
import { cronRuns } from "../../lib/leash/schedules-store.ts";
import { DashShell } from "../../components/dash.tsx";
import { TasksPanel } from "../../components/TasksPanel.tsx";

export const dynamic = "force-dynamic";

const TABS = ["mine", "newsroom", "runs"] as const;
type Tab = (typeof TABS)[number];
const SOURCES: TaskSource[] = ["user", "assistant", "dream", "cron"];

function fmtTime(d: Date | string | number | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function FilterChip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70"
      style={
        active
          ? { background: "var(--color-sage-deep)", color: "var(--color-cream)", borderColor: "var(--color-sage-deep)" }
          : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }
      }
    >
      {label}
    </Link>
  );
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const tab: Tab = TABS.includes(one(params["tab"]) as Tab) ? (one(params["tab"]) as Tab) : "mine";

  return (
    <DashShell kicker="Leash · Work" title="Tasks" lede="Every unit of work — yours, the newsroom's, and the scheduler's.">
      <div className="mb-5 flex gap-2">
        {TABS.map((t) => (
          <Link
            key={t}
            href={t === "mine" ? "/tasks" : `/tasks?tab=${t}`}
            className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70"
            style={
              tab === t
                ? { background: "var(--color-ink)", color: "var(--color-cream)", borderColor: "var(--color-ink)" }
                : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }
            }
            aria-current={tab === t ? "page" : undefined}
          >
            {t[0]?.toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </div>

      {tab === "mine" && <TasksTab params={params} />}
      {tab === "newsroom" && <PipelineTab params={params} />}
      {tab === "runs" && <RunsTab params={params} />}
    </DashShell>
  );
}

/* ── Tasks tab ───────────────────────────────────────────────────────────────── */

async function TasksTab({ params }: { params: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const status = TASK_STATUSES.includes(one(params["status"]) as TaskStatus) ? (one(params["status"]) as TaskStatus) : undefined;
  const source = SOURCES.includes(one(params["source"]) as TaskSource) ? (one(params["source"]) as TaskSource) : undefined;
  const tasks = await listTasks({ status, source });

  const qs = (next: { status?: TaskStatus; source?: TaskSource }): string => {
    const p = new URLSearchParams();
    const s = "status" in next ? next.status : status;
    const src = "source" in next ? next.source : source;
    if (s) p.set("status", s);
    if (src) p.set("source", src);
    const str = p.toString();
    return str ? `/tasks?${str}` : "/tasks";
  };

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          Status
        </span>
        <FilterChip href={qs({ status: undefined })} label="All" active={!status} />
        {TASK_STATUSES.map((s) => (
          <FilterChip key={s} href={qs({ status: s })} label={s.replace("_", " ")} active={status === s} />
        ))}
        <span className="kicker ml-4" style={{ color: "var(--color-faint)" }}>
          Source
        </span>
        <FilterChip href={qs({ source: undefined })} label="All" active={!source} />
        {SOURCES.map((s) => (
          <FilterChip key={s} href={qs({ source: s })} label={s} active={source === s} />
        ))}
      </div>
      <TasksPanel tasks={tasks} />
    </>
  );
}

/* ── Pipeline tab ────────────────────────────────────────────────────────────── */

async function PipelineTab({ params }: { params: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const filter = { stage: one(params["stage"]), date: one(params["date"]), section: one(params["section"]), origin: one(params["origin"]) };
  const [rows, facets] = await Promise.all([getPipeline(filter), getPipelineFacets()]);

  const qs = (key: "stage" | "date" | "section" | "origin", value?: string): string => {
    const p = new URLSearchParams({ tab: "newsroom" });
    for (const k of ["stage", "date", "section", "origin"] as const) {
      const v = k === key ? value : filter[k];
      if (v) p.set(k, v);
    }
    return `/tasks?${p.toString()}`;
  };

  const facetRow = (label: string, key: "stage" | "date" | "section" | "origin", values: { value: string; count: number }[]) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="kicker w-14" style={{ color: "var(--color-faint)" }}>
        {label}
      </span>
      <FilterChip href={qs(key, undefined)} label="All" active={!filter[key]} />
      {values.map((v) => (
        <FilterChip key={v.value} href={qs(key, v.value)} label={`${v.value} (${v.count})`} active={filter[key] === v.value} />
      ))}
    </div>
  );

  return (
    <>
      <div className="mb-5 flex flex-col gap-2">
        {facetRow("Stage", "stage", facets.stages)}
        {facetRow("Date", "date", facets.dates)}
        {facetRow("Section", "section", facets.sections)}
        {facetRow("Origin", "origin", facets.origins)}
      </div>
      {rows.length === 0 ? (
        <p className="kicker py-8 text-center" style={{ color: "var(--color-faint)" }}>
          No articles match these filters.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Stage", "Headline", "Section", "Origin", "Date", "Updated"].map((h) => (
                <th key={h} className="border-b-2 px-2 py-1.5 text-left" style={{ borderColor: "var(--color-ink)" }}>
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>
                    {h}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="border-b px-2 py-2" style={{ borderColor: "var(--color-rule)" }}>
                  <span className="kicker" style={{ color: a.stage === "PUBLISHED" ? "var(--color-sage-deep)" : "var(--color-muted)" }}>
                    {a.stage}
                  </span>
                </td>
                <td className="border-b px-2 py-2" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.9rem" }}>
                  {a.stage === "PUBLISHED" ? (
                    <Link href={`/feed/${a.date}/${a.slug}`} className="transition-opacity hover:opacity-60">
                      {a.headline}
                    </Link>
                  ) : (
                    a.headline
                  )}
                </td>
                <td className="kicker border-b px-2 py-2" style={{ borderColor: "var(--color-rule)", color: "var(--color-muted)" }}>
                  {a.section}
                </td>
                <td className="kicker border-b px-2 py-2" style={{ borderColor: "var(--color-rule)", color: "var(--color-muted)" }}>
                  {a.origin}
                </td>
                <td className="border-b px-2 py-2" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                  {a.date}
                </td>
                <td className="border-b px-2 py-2" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                  {fmtTime(a.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ── Runs tab — executed work records from every service ─────────────────────── */

interface RunRow {
  key: string;
  source: "newsroom" | "cron";
  name: string;
  ok: boolean;
  startedAt: number;
  /** Seconds, or null while still running. */
  seconds: number | null;
  detail: string;
}

async function RunsTab({ params }: { params: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const sourceFilter = one(params["runsource"]);
  const okFilter = one(params["ok"]); // "1" | "0"

  const [{ runs: daemonRuns }, cron] = await Promise.all([getDaemons(60), cronRuns(60)]);
  const rows: RunRow[] = [
    ...daemonRuns.map((r) => ({
      key: `nr-${r.id}`,
      source: "newsroom" as const,
      name: r.kind,
      ok: r.ok,
      startedAt: new Date(r.startedAt).getTime(),
      seconds: r.finishedAt ? (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000 : null,
      detail: r.detail,
    })),
    ...cron.map((r) => ({
      key: `cr-${r.id}`,
      source: "cron" as const,
      name: r.name,
      ok: r.ok,
      startedAt: r.startedAt,
      seconds: (r.finishedAt - r.startedAt) / 1000,
      detail: r.error ?? (r.exitCode !== undefined ? `exit ${r.exitCode}` : ""),
    })),
  ]
    .filter((r) => !sourceFilter || r.source === sourceFilter)
    .filter((r) => okFilter === undefined || (okFilter === "1" ? r.ok : !r.ok))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 80);

  const qs = (next: { runsource?: string; ok?: string }): string => {
    const p = new URLSearchParams({ tab: "runs" });
    const src = "runsource" in next ? next.runsource : sourceFilter;
    const ok = "ok" in next ? next.ok : okFilter;
    if (src) p.set("runsource", src);
    if (ok !== undefined) p.set("ok", ok);
    return `/tasks?${p.toString()}`;
  };

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          Producer
        </span>
        <FilterChip href={qs({ runsource: undefined })} label="All" active={!sourceFilter} />
        <FilterChip href={qs({ runsource: "newsroom" })} label="newsroom" active={sourceFilter === "newsroom"} />
        <FilterChip href={qs({ runsource: "cron" })} label="cron" active={sourceFilter === "cron"} />
        <span className="kicker ml-4" style={{ color: "var(--color-faint)" }}>
          Outcome
        </span>
        <FilterChip href={qs({ ok: undefined })} label="All" active={okFilter === undefined} />
        <FilterChip href={qs({ ok: "1" })} label="ok" active={okFilter === "1"} />
        <FilterChip href={qs({ ok: "0" })} label="failed" active={okFilter === "0"} />
      </div>

      {rows.length === 0 ? (
        <p className="kicker py-8 text-center" style={{ color: "var(--color-faint)" }}>
          No runs match — services record a row here every time they execute a piece of work.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["", "Producer", "Run", "Started", "Duration", "Detail"].map((h, i) => (
                <th key={i} className="border-b-2 px-2 py-1.5 text-left" style={{ borderColor: "var(--color-ink)" }}>
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>
                    {h}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="border-b px-2 py-1.5" style={{ borderColor: "var(--color-rule)", color: r.ok ? "var(--color-sage-deep)" : "var(--color-brick)" }}>
                  {r.ok ? "✓" : "✗"}
                </td>
                <td className="kicker border-b px-2 py-1.5" style={{ borderColor: "var(--color-rule)", color: "var(--color-muted)" }}>
                  {r.source}
                </td>
                <td className="border-b px-2 py-1.5" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                  {r.name}
                </td>
                <td className="border-b px-2 py-1.5" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                  {fmtTime(r.startedAt)}
                </td>
                <td className="border-b px-2 py-1.5" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                  {r.seconds === null ? "…" : `${r.seconds.toFixed(1)}s`}
                </td>
                <td className="border-b px-2 py-1.5" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--color-muted)" }}>
                  {r.detail.slice(0, 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
