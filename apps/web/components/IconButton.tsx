import type { ReactNode } from "react";

/**
 * A borderless ghost icon action button — the house affordance for compact actions: a 14px lucide
 * icon in a 24px hit area, the human label in the hover `title` + `aria-label` (icon + label-on-hover).
 * `color` overrides the default muted tone (e.g. sage for a download, brick for a destructive action);
 * `danger` is the brick shorthand. Shared by the Models table and the mesh / devices UI.
 */
export function IconButton({
  title,
  danger,
  color,
  disabled,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  color?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100 disabled:opacity-25"
      style={{ color: color ?? (danger ? "var(--color-brick)" : "var(--color-muted)") }}
    >
      {children}
    </button>
  );
}
