"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon, CheckCheckIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import type { LeashTask, TaskStatus, TaskPriority, TaskSource } from "../lib/leash/tasks-store.ts";

/* Live (system) rows that share the task list: downloads + services. A task with a different KIND. */
type Dl = { name: string; kind?: "model" | "system"; label?: string; state: "starting" | "downloading" | "done" | "error" | "cancelled"; percentage: number; downloaded: number; total: number; error?: string; updatedAt: number };
type Svc = { name: string; label: string; state: "running" | "external" | "stopped" | "starting" | "ready" | "unhealthy"; detail: string };

/* Downloads/services ARE tasks with a kind — give them a task status so the page's status filter
 * applies to them too (a cancelled/failed download → "dropped" + retryable; an active one →
 * "in_progress"; a finished one → "done"). */
const dlStatus = (s: Dl["state"]): TaskStatus => (s === "done" ? "done" : s === "error" || s === "cancelled" ? "dropped" : "in_progress");
const svcStatus = (s: Svc["state"]): TaskStatus | null => (s === "unhealthy" ? "dropped" : s === "stopped" ? null : "in_progress");
const SVC_VIEW: Record<Svc["state"], { text: string; tone: string } | null> = {
  running: { text: "running", tone: "var(--color-sage-deep)" },
  ready: { text: "ready", tone: "var(--color-sage-deep)" },
  external: { text: "running (external)", tone: "var(--color-sage-deep)" },
  starting: { text: "starting…", tone: "var(--color-muted)" },
  unhealthy: { text: "unhealthy", tone: "var(--color-brick)" },
  stopped: null,
};
const fmtBytes = (n: number): string => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(0)} MB` : `${(n / 1024).toFixed(0)} KB`);

/**
 * The interactive task list (client): inline create, status cycling, priority,
 * delete, and multi-select bulk actions (mark done/open, delete). Server filters via
 * query params (the page re-reads the store); mutations go through /api/leash/tasks
 * and refresh the server component. Bulk ops fan out over the existing per-task
 * endpoints (the store's write mutex serializes them) and report partial failures.
 */

const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", in_progress: "In progress", done: "Done", dropped: "Dropped" };
const STATUSES: TaskStatus[] = ["open", "in_progress", "done", "dropped"];
const PRIORITIES: TaskPriority[] = ["low", "normal", "high"];

function relTime(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TasksPanel({
  tasks,
  downloads: initialDownloads = [],
  statusFilter,
  sourceFilter,
}: {
  tasks: LeashTask[];
  downloads?: Dl[];
  statusFilter?: TaskStatus;
  sourceFilter?: TaskSource;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Live rows (downloads + active services) share the list. Poll here — on the Tasks page — so they
  // keep updating no matter where you were, and a download/service is just a task with a `kind`.
  const [downloads, setDownloads] = useState<Dl[]>(initialDownloads);
  const [services, setServices] = useState<Svc[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const [dr, sr] = await Promise.all([
          fetchWithTimeout("/api/leash/downloads", { cache: "no-store" }, 4000),
          fetchWithTimeout("/api/leash/services", { cache: "no-store" }, 4000),
        ]);
        if (alive && dr.ok) setDownloads(((await dr.json()) as { downloads: Dl[] }).downloads);
        if (alive && sr.ok) setServices(((await sr.json()) as { services: Svc[] }).services ?? []);
      } catch {
        /* transient — next tick */
      }
    };
    const id = setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const activeServices = services.filter((s) => SVC_VIEW[s.state] !== null);
  const postDownload = (d: Dl, action: "retry" | "cancel"): Promise<unknown> =>
    fetchWithTimeout("/api/leash/downloads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: d.name, kind: d.kind ?? "model", action }) }, 15000).catch(() => undefined);
  const retryDownload = async (d: Dl): Promise<void> => {
    const key = `${d.kind ?? "model"}:${d.name}`;
    setRetrying((s) => new Set(s).add(key));
    await postDownload(d, "retry");
    setTimeout(() => setRetrying((s) => { const n = new Set(s); n.delete(key); return n; }), 4000);
  };
  const cancelDownload = async (d: Dl): Promise<void> => {
    // Optimistically mark it cancelled (NOT remove it) — a cancelled download becomes a retryable
    // "dropped" row, not a vanished one. The next poll confirms the persisted "cancelled" state.
    setDownloads((ds) =>
      ds.map((x) => (x.name === d.name && (x.kind ?? "model") === (d.kind ?? "model") ? { ...x, state: "cancelled" as const, error: "cancelled by you" } : x)),
    );
    await postDownload(d, "cancel");
  };

  // Downloads/services share the page's status filter (they're tasks-with-a-kind). They aren't
  // task-SOURCED, so any active source filter hides them (source filters task origins, not infra).
  const showLiveRows = !sourceFilter;
  const visibleDownloads = downloads.filter((d) => showLiveRows && (!statusFilter || dlStatus(d.state) === statusFilter));
  const visibleServices = activeServices.filter((s) => showLiveRows && (!statusFilter || svcStatus(s.state) === statusFilter));

  // Selection against the CURRENTLY LISTED (server-filtered) tasks only.
  const listedSelected = tasks.filter((t) => selected.has(t.id));
  const allSelected = tasks.length > 0 && listedSelected.length === tasks.length;

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(tasks.map((t) => t.id)));

  /** Fan one request out per selected task; aggregate partial failures into `error`. */
  const bulk = async (label: string, fn: (id: string) => Promise<Response>) => {
    const ids = listedSelected.map((t) => t.id);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return (await fn(id)).ok;
          } catch {
            return false;
          }
        }),
      );
      const failed = results.filter((ok) => !ok).length;
      if (failed > 0) setError(`${ids.length - failed} of ${ids.length} ${label} — ${failed} failed.`);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const bulkStatus = (status: TaskStatus, label: string) =>
    void bulk(label, (id) => fetchWithTimeout(`/api/leash/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }));

  const bulkDelete = () => {
    const n = listedSelected.length;
    if (!confirm(`Delete ${n} selected task${n === 1 ? "" : "s"}? This can't be undone.`)) return;
    void bulk("deleted", (id) => fetchWithTimeout(`/api/leash/tasks/${id}`, { method: "DELETE" }));
  };

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(`Request failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, ...(detail.trim() ? { detail } : {}) }),
      });
      if (res.ok) {
        setTitle("");
        setDetail("");
      } else {
        setError(`Couldn't create the task (${res.status}).`);
      }
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  const patch = (id: string, body: Record<string, unknown>) =>
    call(() => fetchWithTimeout(`/api/leash/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  const del = (id: string) => {
    if (!confirm("Delete this task?")) return;
    void call(() => fetchWithTimeout(`/api/leash/tasks/${id}`, { method: "DELETE" }));
  };

  return (
    <div>
      {/* Create */}
      <form onSubmit={create} className="mb-5 flex flex-wrap items-start gap-2 border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task…"
          aria-label="New task title"
          className="min-w-[220px] flex-1 border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-body)", fontSize: "0.95rem" }}
        />
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Detail (optional)"
          aria-label="New task detail"
          className="min-w-[220px] flex-[2] border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.95rem" }}
        />
        <button
          type="submit"
          disabled={busy || !title.trim()}
          title="Add task"
          aria-label="Add task"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}
        >
          <PlusIcon size={18} />
        </button>
      </form>
      {error && (
        <p className="kicker mb-4" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {/* Bulk bar — appears once anything is selected */}
      {listedSelected.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 border p-3" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}>
          <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>
            {listedSelected.length} selected
          </span>
          <IconButton title="Mark done" color="var(--color-sage-deep)" disabled={busy} onClick={() => bulkStatus("done", "marked done")}>
            <CheckCheckIcon size={16} />
          </IconButton>
          <IconButton title="Mark open" disabled={busy} onClick={() => bulkStatus("open", "marked open")}>
            <RotateCcwIcon size={15} />
          </IconButton>
          <IconButton title="Delete selected" danger disabled={busy} onClick={bulkDelete}>
            <Trash2Icon size={15} />
          </IconButton>
          <span className="h-4 w-px" style={{ background: "var(--color-rule-strong)" }} />
          <IconButton title="Clear selection" disabled={busy} onClick={() => setSelected(new Set())}>
            <XIcon size={15} />
          </IconButton>
        </div>
      )}

      {/* List */}
      {tasks.length === 0 && visibleDownloads.length === 0 && visibleServices.length === 0 ? (
        <p className="kicker py-8 text-center" style={{ color: "var(--color-faint)" }}>
          No tasks match — add one above, or ask Leash to &ldquo;remind me to…&rdquo; in chat.
        </p>
      ) : (
        <ul>
          {/* Live rows — a download/service is a task with a different KIND (same row style). */}
          {visibleDownloads.map((d) => {
            const key = `${d.kind ?? "model"}:${d.name}`;
            const label = d.label ?? d.name;
            const pct = Math.max(0, Math.min(100, Math.round(d.percentage || 0)));
            const failed = d.state === "error";
            const cancelled = d.state === "cancelled";
            const done = d.state === "done";
            const retryable = failed || cancelled; // both are "dropped" — offer a restart
            const isRetrying = retrying.has(key);
            return (
              <li key={key} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: done || cancelled ? 0.55 : 1 }}>
                <span className="kicker border px-2 py-1" style={{ borderColor: "var(--color-rule-strong)", color: failed ? "var(--color-brick)" : done ? "var(--color-sage-deep)" : "var(--color-muted)" }}>
                  {failed ? "failed" : cancelled ? "cancelled" : done ? "done" : "downloading"}
                </span>
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>{label}</p>
                  {!retryable && !done && (
                    <div className="mt-1 h-1.5 w-full max-w-sm" style={{ background: "var(--color-rule)" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: "var(--color-sage-deep)", transition: "width 0.3s" }} />
                    </div>
                  )}
                  {retryable && d.error && (
                    <p className="kicker mt-1" style={{ color: failed ? "var(--color-brick)" : "var(--color-muted)" }}>
                      {d.error.slice(0, 140)}
                    </p>
                  )}
                  <p className="kicker mt-1 flex flex-wrap gap-2" style={{ color: "var(--color-faint)" }}>
                    <span>download · {d.kind ?? "model"}</span>
                    {!retryable && !done && d.total > 0 && (
                      <span>
                        {pct}% · {fmtBytes(d.downloaded)} / {fmtBytes(d.total)}
                      </span>
                    )}
                    <span suppressHydrationWarning>{relTime(d.updatedAt)}</span>
                  </p>
                </div>
                {retryable ? (
                  <button
                    onClick={() => void retryDownload(d)}
                    disabled={isRetrying}
                    className="kicker flex items-center gap-1 border px-2 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
                    style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
                  >
                    <RotateCcwIcon size={13} /> {isRetrying ? "retrying…" : "retry"}
                  </button>
                ) : !done ? (
                  <button
                    onClick={() => void cancelDownload(d)}
                    title="Cancel this download"
                    className="kicker flex items-center gap-1 border px-2 py-1 transition-opacity hover:opacity-70"
                    style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
                  >
                    <XIcon size={13} /> cancel
                  </button>
                ) : null}
              </li>
            );
          })}
          {visibleServices.map((s) => {
            const v = SVC_VIEW[s.state]!;
            return (
              <li key={`svc:${s.name}`} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)" }}>
                <span className="kicker border px-2 py-1" style={{ borderColor: "var(--color-rule-strong)", color: v.tone }}>
                  {v.text}
                </span>
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>{s.label}</p>
                  <p className="kicker mt-1 flex flex-wrap gap-2" style={{ color: "var(--color-faint)" }}>
                    <span>service</span>
                    {s.detail && <span>{s.detail.slice(0, 100)}</span>}
                  </p>
                </div>
              </li>
            );
          })}
          {tasks.length > 0 && (
            <li className="flex items-center gap-3 border-b py-2" style={{ borderColor: "var(--color-rule)" }}>
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} disabled={busy} aria-label="Select all listed tasks" />
              <span className="kicker" style={{ color: "var(--color-faint)" }}>
                Select all ({tasks.length} listed)
              </span>
            </li>
          )}
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: t.status === "done" || t.status === "dropped" ? 0.55 : 1 }}>
              <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} disabled={busy} aria-label={`Select task: ${t.title}`} />
              <select
                value={t.status}
                onChange={(e) => void patch(t.id, { status: e.target.value })}
                disabled={busy}
                aria-label="Status"
                className="kicker border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--color-rule-strong)" }}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>

              <div className="min-w-0 flex-1">
                <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem", textDecoration: t.status === "done" ? "line-through" : undefined }}>{t.title}</p>
                {t.detail && (
                  <p className="mt-0.5" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
                    {t.detail}
                  </p>
                )}
                <p className="kicker mt-1 flex flex-wrap gap-2" style={{ color: "var(--color-faint)" }}>
                  <span>{t.source}</span>
                  {t.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                  <span suppressHydrationWarning>{relTime(t.updatedAt)}</span>
                  {t.chatIds.slice(0, 2).map((cid) => (
                    <Link key={cid} href={`/chat/${cid}`} className="underline transition-opacity hover:opacity-60">
                      chat ↗
                    </Link>
                  ))}
                </p>
              </div>

              <select
                value={t.priority}
                onChange={(e) => void patch(t.id, { priority: e.target.value })}
                disabled={busy}
                aria-label="Priority"
                className="kicker border bg-transparent px-2 py-1"
                style={{ borderColor: "var(--color-rule)", color: t.priority === "high" ? "var(--color-brick)" : "var(--color-muted)" }}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>

              <IconButton title="Delete task" danger disabled={busy} onClick={() => del(t.id)}>
                <Trash2Icon size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
