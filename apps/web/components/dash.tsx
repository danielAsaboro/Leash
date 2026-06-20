/**
 * Shared dashboard primitives for the Leash management pages (/home /models /brain
 * /activity) — light broadsheet styling (cream/paper/rule tokens), server-renderable.
 * Mission Control keeps its own dark "control room" look; these pages live in the
 * paper's world.
 */
import type { ReactNode } from "react";

/** Page chrome: kicker + masthead-style title, then content. */
export function DashShell({ kicker, title, lede, children }: { kicker: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: "var(--color-cream)" }}>
      <header className="mx-auto max-w-[1180px] px-5 pt-6">
        <span className="kicker kicker-sage">{kicker}</span>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "2rem", lineHeight: 1.05 }}>{title}</h1>
        {lede && (
          <p className="mt-1 italic" style={{ color: "var(--color-muted)", fontFamily: "var(--font-body)" }}>
            {lede}
          </p>
        )}
        <div className="mt-3 border-t-2" style={{ borderColor: "var(--color-ink)" }} />
        <div className="mt-[2px] border-t" style={{ borderColor: "var(--color-ink)" }} />
      </header>
      <main className="mx-auto max-w-[1180px] px-5 py-6">{children}</main>
    </div>
  );
}

/** A bordered card with a kicker heading. */
export function DashCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <div className="mb-3 flex items-center gap-3">
        <span className="kicker kicker-sage">{title}</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {action}
      </div>
      {children}
    </section>
  );
}

/** Big-number stat. */
export function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "2.1rem", lineHeight: 1, color: accent ? "var(--color-sage-deep)" : "var(--color-ink)" }}>
        {value}
      </span>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        {label}
      </span>
    </div>
  );
}

/** Label → value line. */
export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        {label}
      </span>
      <span className="text-right" style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--color-ink-soft)" }}>
        {value}
      </span>
    </div>
  );
}

/** Green/red/grey state dot + label. */
export function StateBadge({ ok, label }: { ok: boolean | null; label: string }) {
  const color = ok === null ? "var(--color-faint)" : ok ? "var(--color-sage)" : "var(--color-brick)";
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>
        {label}
      </span>
    </span>
  );
}
