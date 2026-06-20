import Link from "next/link";
import { BrainIcon, FileTextIcon, MonitorIcon, ArrowUpRightIcon } from "lucide-react";
import type { LeashMemory } from "../lib/leash/memories-store.ts";
import type { NoteView, ActivityPage, IndexStats } from "../lib/leash/memory-admin.ts";

/**
 * Memory landing (server) — a compact OVERVIEW of what the assistant recalls, with the full
 * editable lists on dedicated pages (/brain/memory, /brain/notes, /brain/screen-activity).
 * Each card: an icon-title link to its page, the count, and the latest few items as a
 * read-only preview. The full dump used to live inline on /brain — this replaces it.
 */

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}
function fmtTime(ms: number | string): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function Card({ href, icon, title, count, open, children }: { href: string; icon: React.ReactNode; title: string; count: string; open: string; children: React.ReactNode }) {
  return (
    <section className="border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <Link href={href} title={open} aria-label={open} className="group flex items-center gap-2">
        <span style={{ color: "var(--color-sage-deep)" }}>{icon}</span>
        <span className="kicker kicker-sage">{title}</span>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          {count}
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <ArrowUpRightIcon size={15} className="opacity-50 transition-opacity group-hover:opacity-100" style={{ color: "var(--color-muted)" }} />
      </Link>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function MemoryLanding({ memories, notes, activity, stats }: { memories: LeashMemory[]; notes: NoteView[]; activity: ActivityPage; stats: IndexStats }) {
  const topMemories = [...memories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const topNotes = [...notes].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
  const muted = { color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" } as const;
  const faint = { color: "var(--color-faint)" } as const;
  const empty = (t: string) => <p className="kicker py-2" style={faint}>{t}</p>;

  return (
    <div className="flex flex-col gap-5">
      <p className="kicker" style={faint}>
        Index: {stats.noteFiles} local context file(s){stats.noteChunks !== null ? ` · ${stats.noteChunks} context chunks` : " · local context not embedded yet"} · {stats.activityRecords} activity record(s)
        {stats.activityChunks !== null ? ` · ${stats.activityChunks} activity chunks` : " · activity not embedded yet"}
      </p>

      <Card href="/brain/memory" icon={<BrainIcon size={16} />} title="Memories" count={`${memories.length}`} open="Open Memories">
        {topMemories.length === 0
          ? empty("No memories yet — open to add one.")
          : (
            <ul className="flex flex-col gap-1.5">
              {topMemories.map((m) => (
                <li key={m.id} className="flex items-baseline gap-2">
                  <span className="kicker shrink-0" style={{ color: m.type === "preference" ? "var(--color-sage-deep)" : "var(--color-faint)" }}>
                    {m.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={muted}>{m.text}</span>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Card href="/brain/notes" icon={<FileTextIcon size={16} />} title="Local context" count={`${notes.length}`} open="Open local context">
        {topNotes.length === 0
          ? empty("No local context files indexed.")
          : (
            <ul className="flex flex-col gap-1.5">
              {topNotes.map((n) => (
                <li key={n.file} className="flex items-baseline gap-2">
                  <span className="shrink-0" style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--color-ink-soft)" }}>{n.file}</span>
                  <span className="min-w-0 flex-1 truncate" style={muted}>{truncate(n.preview, 90)}</span>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Card href="/brain/screen-activity" icon={<MonitorIcon size={16} />} title="Screen activity" count={`${activity.total}`} open="Open Screen activity">
        {activity.records.length === 0
          ? empty("No activity recorded — start the watcher with `npm run watch`.")
          : (
            <ul className="flex flex-col gap-1.5">
              {activity.records.slice(0, 5).map((r) => (
                <li key={r.ts} className="flex items-baseline gap-2">
                  <span className="shrink-0" style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem", ...faint }}>{fmtTime(r.ts)} · {r.app}</span>
                  <span className="min-w-0 flex-1 truncate" style={muted}>{r.summary}</span>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  );
}
