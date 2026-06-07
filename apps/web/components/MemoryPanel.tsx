"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { NoteView, ActivityPage } from "../lib/leash/memory-admin.ts";
import type { IndexStats } from "../lib/leash/graph.ts";

/**
 * The Memory browser (client) — what the assistant can recall, with REAL forgetting:
 * deleting a note removes the file (the graph re-embeds via its directory fingerprint);
 * forgetting an activity record tombstones it (the watcher's JSONL is never rewritten).
 */

function fmtTime(ms: number | string): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function MemoryPanel({ notes, activity, stats, offset }: { notes: NoteView[]; activity: ActivityPage; stats: IndexStats; offset: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async (payload: { kind: "note"; file: string } | { kind: "activity"; ts: string }) => {
    const label = payload.kind === "note" ? `Delete the note "${payload.file}"? The assistant will no longer recall it.` : "Forget this activity record? The assistant will no longer recall it.";
    if (!confirm(label)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/memory/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) setError(`Forget failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Forget failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {/* Index stats */}
      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Index: {stats.noteFiles} note file(s){stats.noteChunks !== null ? ` · ${stats.noteChunks} note chunks embedded` : " · notes not embedded yet"} · {stats.activityRecords} activity record(s)
        {stats.activityChunks !== null ? ` · ${stats.activityChunks} activity chunks embedded` : " · activity not embedded yet"}
      </p>

      {/* Notes */}
      <section>
        <div className="mb-2 flex items-center gap-3">
          <span className="kicker kicker-sage">Notes</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        </div>
        {notes.length === 0 ? (
          <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
            No notes — drop .md files into data/notes and the assistant will recall them.
          </p>
        ) : (
          <ul>
            {notes.map((n) => (
              <li key={n.file} className="flex items-start gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)" }}>
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                    {n.file} <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>{n.chunks} chunk(s) · {fmtTime(n.mtimeMs)}</span>
                  </p>
                  <p className="mt-0.5" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
                    {n.preview}
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={() => void forget({ kind: "note", file: n.file })} className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Activity */}
      <section>
        <div className="mb-2 flex items-center gap-3">
          <span className="kicker kicker-sage">Screen activity</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            {activity.total} record(s)
          </span>
        </div>
        {activity.records.length === 0 ? (
          <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
            No activity recorded{activity.total > 0 ? " on this page" : " — start the watcher with `npm run watch`"}.
          </p>
        ) : (
          <ul>
            {activity.records.map((r) => (
              <li key={r.ts} className="flex items-start gap-3 border-b py-2.5" style={{ borderColor: "var(--color-rule)" }}>
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                    {fmtTime(r.ts)} · {r.app}
                    {r.window ? ` — ${r.window}` : ""}
                  </p>
                  <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{r.summary}</p>
                </div>
                <button type="button" disabled={busy} onClick={() => void forget({ kind: "activity", ts: r.ts })} className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Pager */}
        {activity.total > activity.records.length && (
          <div className="mt-3 flex gap-2">
            {offset > 0 && (
              <button type="button" onClick={() => router.push(`/brain?tab=memory&offset=${Math.max(0, offset - 50)}`)} className="kicker border px-3 py-1.5" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                ← Newer
              </button>
            )}
            {offset + activity.records.length < activity.total && (
              <button type="button" onClick={() => router.push(`/brain?tab=memory&offset=${offset + 50}`)} className="kicker border px-3 py-1.5" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                Older →
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
