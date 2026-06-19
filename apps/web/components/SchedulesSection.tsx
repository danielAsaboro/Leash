"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import type { ScheduleEntry, CronScheduleState, CronRun, JobScript } from "../lib/leash/schedules-store.ts";

/**
 * Schedule CRUD (client) — lives on the Scheduler service card. Definitions + timing
 * (last/next run, run history) are served by the schedules API, which is backed by the
 * mcp-cron engine; the UI shape is unchanged from the leash-cron era.
 */

const JOBS: JobScript[] = ["dream", "tag-photos"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function describeShape(e: ScheduleEntry): string {
  const s = e.schedule;
  if (s.type === "once") return `once at ${fmtTime(new Date(s.at).getTime())}`;
  if (s.type === "interval") return `every ${s.minutes} min`;
  if (s.type === "daily") return `daily at ${s.at}`;
  return `${DAYS[s.day] ?? "?"} at ${s.at}`;
}

export function SchedulesSection({ schedules, state, runs }: { schedules: ScheduleEntry[]; state: Record<string, CronScheduleState>; runs: CronRun[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "job" as "job" | "task", script: "dream" as JobScript, researchQ: "", taskTitle: "", shapeType: "daily" as "once" | "interval" | "daily" | "weekly", at: "03:30", onceAt: "", minutes: 60, day: 1 });

  const call = async (fn: () => Promise<Response>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
      }
      router.refresh();
      return res.ok;
    } catch {
      setError("Request failed — is the app still running?");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const schedule =
      draft.shapeType === "once"
        ? { type: "once" as const, at: new Date(draft.onceAt).toISOString() }
        : draft.shapeType === "interval"
          ? { type: "interval" as const, minutes: Number(draft.minutes) }
          : draft.shapeType === "daily"
            ? { type: "daily" as const, at: draft.at }
            : { type: "weekly" as const, day: Number(draft.day), at: draft.at };
    const body = {
      name: draft.name.trim() || (draft.kind === "job" ? `Run ${draft.script}` : draft.taskTitle.trim()),
      enabled: true,
      kind: draft.kind,
      schedule,
      ...(draft.kind === "job" ? { job: { script: draft.script, ...(draft.script === "research" ? { args: [draft.researchQ.trim()] } : {}) } } : { task: { title: draft.taskTitle.trim() } }),
    };
    const ok = await call(() => fetchWithTimeout("/api/leash/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    if (ok) {
      setAdding(false);
      setDraft((d) => ({ ...d, name: "", taskTitle: "", onceAt: "" }));
    }
  };

  const toggle = (e: ScheduleEntry) =>
    void call(() => fetchWithTimeout(`/api/leash/schedules/${e.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !e.enabled }) }));

  const del = async (e: ScheduleEntry) => {
    if (!(await appConfirm(`Delete the schedule "${e.name}"?`, { confirmLabel: "Delete", destructive: true }))) return;
    void call(() => fetchWithTimeout(`/api/leash/schedules/${e.id}`, { method: "DELETE" }));
  };

  const input = "border bg-transparent px-2 py-1.5";
  const inputStyle = { borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-body)", fontSize: "0.85rem" } as React.CSSProperties;

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
      <div className="mb-2 flex items-center gap-3">
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          Schedules — jobs and recurring tasks this service fires
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
            ＋ New schedule
          </button>
        )}
      </div>
      {error && (
        <p className="kicker mb-2" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {adding && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border p-3" style={{ borderColor: "var(--color-rule-strong)" }}>
          <select value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as "job" | "task" }))} aria-label="Kind" className={`kicker ${input}`} style={inputStyle}>
            <option value="job">job</option>
            <option value="task">task</option>
          </select>
          {draft.kind === "job" ? (
            <>
              <select value={draft.script} onChange={(e) => setDraft((d) => ({ ...d, script: e.target.value as JobScript }))} aria-label="Script" className={`kicker ${input}`} style={inputStyle}>
                {JOBS.map((j) => (
                  <option key={j} value={j}>
                    {j === "research" ? "deep research" : `npm run ${j}`}
                  </option>
                ))}
              </select>
              {draft.script === "research" && (
                <input value={draft.researchQ} onChange={(e) => setDraft((d) => ({ ...d, researchQ: e.target.value }))} placeholder="Research question…" aria-label="Research question" className={`min-w-[200px] flex-1 ${input}`} style={inputStyle} />
              )}
            </>
          ) : (
            <input value={draft.taskTitle} onChange={(e) => setDraft((d) => ({ ...d, taskTitle: e.target.value }))} placeholder="Task title to create…" aria-label="Task title" className={`min-w-[200px] flex-1 ${input}`} style={inputStyle} />
          )}
          <select value={draft.shapeType} onChange={(e) => setDraft((d) => ({ ...d, shapeType: e.target.value as typeof draft.shapeType }))} aria-label="Schedule type" className={`kicker ${input}`} style={inputStyle}>
            <option value="once">once</option>
            <option value="interval">interval</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
          </select>
          {draft.shapeType === "once" && <input type="datetime-local" value={draft.onceAt} onChange={(e) => setDraft((d) => ({ ...d, onceAt: e.target.value }))} aria-label="When" className={input} style={inputStyle} />}
          {draft.shapeType === "interval" && (
            <label className="kicker flex items-center gap-1" style={{ color: "var(--color-muted)" }}>
              every <input type="number" min={1} value={draft.minutes} onChange={(e) => setDraft((d) => ({ ...d, minutes: Number(e.target.value) }))} aria-label="Minutes" className={`w-20 ${input}`} style={inputStyle} /> min
            </label>
          )}
          {(draft.shapeType === "daily" || draft.shapeType === "weekly") && (
            <>
              {draft.shapeType === "weekly" && (
                <select value={draft.day} onChange={(e) => setDraft((d) => ({ ...d, day: Number(e.target.value) }))} aria-label="Day" className={`kicker ${input}`} style={inputStyle}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              <input type="time" value={draft.at} onChange={(e) => setDraft((d) => ({ ...d, at: e.target.value }))} aria-label="Time" className={input} style={inputStyle} />
            </>
          )}
          <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Name (optional)" aria-label="Schedule name" className={`min-w-[140px] ${input}`} style={inputStyle} />
          <button type="button" disabled={busy || (draft.kind === "task" && !draft.taskTitle.trim()) || (draft.kind === "job" && draft.script === "research" && !draft.researchQ.trim()) || (draft.shapeType === "once" && !draft.onceAt)} onClick={() => void add()} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            Save
          </button>
          <button type="button" disabled={busy} onClick={() => setAdding(false)} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
            Cancel
          </button>
        </div>
      )}

      {schedules.length === 0 ? (
        <p className="kicker py-3" style={{ color: "var(--color-faint)" }}>
          No schedules yet.
        </p>
      ) : (
        <ul>
          {schedules.map((e) => {
            const st = state[e.id] ?? {};
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-3 border-b py-2" style={{ borderColor: "var(--color-rule)", opacity: e.enabled ? 1 : 0.55 }}>
                <input type="checkbox" checked={e.enabled} onChange={() => toggle(e)} disabled={busy} aria-label={`Enable ${e.name}`} />
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem" }}>
                    {e.name} <span className="kicker ml-1" style={{ color: "var(--color-faint)" }}>{e.kind === "job" ? (e.job?.script === "research" ? `research "${(e.job?.args?.[0] ?? "").slice(0, 40)}"` : `npm run ${e.job?.script}`) : `creates task "${e.task?.title}"`} · {describeShape(e)}</span>
                  </p>
                </div>
                <span className="kicker" style={{ color: "var(--color-faint)" }} suppressHydrationWarning>
                  last {fmtTime(st.lastRun)}
                  {st.lastRun ? (st.lastOk ? " ✓" : " ✗") : ""} · next {fmtTime(st.nextRun)}
                </span>
                <button type="button" onClick={() => void del(e)} disabled={busy} aria-label={`Delete ${e.name}`} className="px-2 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {runs.length > 0 && (
        <div className="mt-3">
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            Recent runs
          </span>
          <ul className="mt-1">
            {runs.slice(0, 8).map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 py-0.5" style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                <span style={{ color: r.ok ? "var(--color-sage-deep)" : "var(--color-brick)" }}>
                  {r.ok ? "✓" : "✗"} {r.name}
                  {r.error ? ` — ${r.error.slice(0, 60)}` : ""}
                </span>
                <span style={{ color: "var(--color-faint)" }} suppressHydrationWarning>
                  {fmtTime(r.startedAt)} · {((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
