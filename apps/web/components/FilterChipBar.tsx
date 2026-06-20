"use client";
import type { LucideIcon } from "lucide-react";

/** One filter chip — a key, its label, and an optional leading lucide icon (used by the kind row). */
export interface FilterChip {
  key: string;
  label: string;
  Icon?: LucideIcon;
}

/**
 * A row of filter chips (SAGE-fill active, ruled-outline inactive) — these are FILTERS, not
 * navigation, so the active chip is green; the black/ink fill is reserved for the page's main
 * TAB nav. Used for the Models browser's facet rows. Optional `label` names the field being
 * filtered (e.g. "Status" / "Kind"), like the /activity filters. `active` is the selected key;
 * clicking a chip calls `onChange(key)`. Optional `counts` render as a muted trailing number so
 * the user can see how many rows each facet would show before clicking it.
 */
export function FilterChipBar({
  chips,
  active,
  onChange,
  counts,
  label,
}: {
  chips: FilterChip[];
  active: string;
  onChange: (key: string) => void;
  counts?: Record<string, number>;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label && (
        <span className="kicker w-12 shrink-0" style={{ color: "var(--color-faint)" }}>
          {label}
        </span>
      )}
      {chips.map((c) => {
        const on = active === c.key;
        const Icon = c.Icon;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(c.key)}
            className="kicker inline-flex items-center gap-1.5 border px-3 py-1.5 transition-opacity hover:opacity-70"
            style={
              on
                ? { background: "var(--color-sage-deep)", color: "var(--color-cream)", borderColor: "var(--color-sage-deep)" }
                : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }
            }
          >
            {Icon && <Icon size={13} aria-hidden />}
            {c.label}
            {counts && <span style={{ opacity: 0.55 }}>{counts[c.key] ?? 0}</span>}
          </button>
        );
      })}
    </div>
  );
}
