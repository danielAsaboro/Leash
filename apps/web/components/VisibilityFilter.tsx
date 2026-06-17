"use client";
import type { ChangeEvent } from "react";

/** Three-way source filter shared by Brain → MCP / Skills / Agents. */
export type Visibility = "all" | "builtin" | "custom";

/**
 * A small dropdown that toggles list visibility between All / Built-in / Custom. Styled to the
 * ruled-outline filter idiom (muted text, strong rule border) rather than the SAGE-fill chips,
 * since it's a compact single control in a panel's header row. Optional `counts` append a muted
 * "(n)" to each option so the user sees how many rows each choice would show before selecting it.
 */
export function VisibilityFilter({
  value,
  onChange,
  builtinLabel = "Built-in",
  customLabel = "Custom",
  counts,
}: {
  value: Visibility;
  onChange: (v: Visibility) => void;
  builtinLabel?: string;
  customLabel?: string;
  counts?: Record<Visibility, number>;
}) {
  const label = (v: Visibility, text: string) => (counts ? `${text} (${counts[v]})` : text);
  return (
    <select
      aria-label="Filter by source"
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as Visibility)}
      className="kicker border bg-transparent px-2 py-1.5 transition-opacity hover:opacity-70"
      style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)", fontFamily: "var(--font-body)" }}
    >
      <option value="all">{label("all", "All")}</option>
      <option value="builtin">{label("builtin", builtinLabel)}</option>
      <option value="custom">{label("custom", customLabel)}</option>
    </select>
  );
}
