"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { LeashTask, TaskStatus, TaskPriority } from "../lib/leash/tasks-store.ts";

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

export function TasksPanel({ tasks }: { tasks: LeashTask[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
          className="kicker px-4 py-2.5 transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}
        >
          Add task
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
          <button
            type="button"
            disabled={busy}
            onClick={() => bulkStatus("done", "marked done")}
            className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
          >
            Mark done
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => bulkStatus("open", "marked open")}
            className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
          >
            Mark open
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={bulkDelete}
            className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}
          >
            Delete
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelected(new Set())}
            className="kicker px-2 py-1.5 transition-opacity hover:opacity-70"
            style={{ color: "var(--color-faint)" }}
          >
            Clear
          </button>
        </div>
      )}

      {/* List */}
      {tasks.length === 0 ? (
        <p className="kicker py-8 text-center" style={{ color: "var(--color-faint)" }}>
          No tasks match — add one above, or ask Leash to &ldquo;remind me to…&rdquo; in chat.
        </p>
      ) : (
        <ul>
          <li className="flex items-center gap-3 border-b py-2" style={{ borderColor: "var(--color-rule)" }}>
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} disabled={busy} aria-label="Select all listed tasks" />
            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              Select all ({tasks.length} listed)
            </span>
          </li>
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

              <button type="button" onClick={() => del(t.id)} disabled={busy} title="Delete task" aria-label="Delete task" className="px-2 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
