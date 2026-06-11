import Link from "next/link";

/** A row of tab chips (ink-fill active, ruled-outline inactive) — the shared tab bar used by
 *  /settings (and retrofittable to /brain). The page computes `active` from its searchParams. */
export interface TabDef {
  key: string;
  label: string;
  href: string;
}

export function TabNav({ tabs, active }: { tabs: TabDef[]; active: string }) {
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70"
          style={
            active === t.key
              ? { background: "var(--color-ink)", color: "var(--color-cream)", borderColor: "var(--color-ink)" }
              : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }
          }
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
