import Link from "next/link";
import { SearchTrigger } from "./SearchPalette.tsx";

const TABS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "AI", label: "AI" },
  { key: "COMPUTE", label: "Compute" },
  { key: "SOLANA", label: "Solana" },
  { key: "BRIEF", label: "Brief" },
];

/** The section rail under the masthead: tabs left, search trigger far right. */
export function CategoryNav({
  date,
  active = "ALL",
  counts = {},
}: {
  date: string;
  active?: string;
  counts?: Record<string, number>;
}) {
  return (
    <nav className="mx-auto max-w-[1180px] px-5">
      <div className="flex items-center justify-between gap-4 py-3">
        <ul className="flex flex-wrap items-center gap-x-7 gap-y-2">
          {TABS.map((t) => {
            const isActive = active === t.key;
            const href = t.key === "ALL" ? `/feed/${date}` : `/feed/${date}?section=${t.key}`;
            const n = t.key === "ALL" ? undefined : counts[t.key];
            return (
              <li key={t.key}>
                <Link
                  href={href}
                  className="kicker inline-flex items-center gap-1.5 pb-1 transition-colors"
                  style={{
                    color: isActive ? "var(--color-ink)" : "var(--color-muted)",
                    borderBottom: isActive ? "2px solid var(--color-sage)" : "2px solid transparent",
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  {t.label}
                  {n ? <sup style={{ color: "var(--color-sage-deep)", fontSize: "0.6rem" }}>{n}</sup> : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <SearchTrigger />
      </div>
      <div className="border-t" style={{ borderColor: "var(--color-rule)" }} />
    </nav>
  );
}
