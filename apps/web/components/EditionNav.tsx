import Link from "next/link";
import { formatLong, formatShort } from "../lib/date.ts";

/**
 * Date pagination between editions — ← older, newer →. Newspaper semantics: the left
 * arrow walks *back in time* to the previous edition, the right arrow forward to the
 * next. Renders a full masthead-dateline row (`variant="full"`, with the long date +
 * counts) and a leaner footer row (`variant="footer"`). Navigating an edition drops
 * any section filter — you land on the full front page of that day.
 */
export function EditionNav({
  date,
  prev,
  next,
  published,
  inProduction,
  section,
  variant = "full",
}: {
  date: string;
  prev: string | null;
  next: string | null;
  published?: number;
  inProduction?: number;
  section?: string;
  variant?: "full" | "footer";
}) {
  const compact = variant === "footer";
  return (
    <div className={`flex items-stretch justify-between gap-3 ${compact ? "py-5" : "py-3"}`}>
      {/* ← Previous (older) edition */}
      <div className="flex flex-1 items-center">
        {prev ? (
          <Link href={`/feed/${prev}`} className="edition-nav-link">
            <span className="edition-nav-arrow" aria-hidden>←</span>
            <span className="flex flex-col">
              <span className="kicker" style={{ color: "var(--color-faint)" }}>Previous</span>
              <span className="edition-nav-date">{formatShort(prev)}</span>
            </span>
          </Link>
        ) : (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>Earliest edition</span>
        )}
      </div>

      {/* Center — the current edition's dateline (full row only) */}
      {compact ? (
        <span className="kicker self-center" style={{ color: "var(--color-muted)" }}>
          Edition · {formatShort(date)}
        </span>
      ) : (
        <div className="flex flex-col items-center justify-center text-center">
          <span className="kicker" style={{ color: "var(--color-ink)" }}>
            {formatLong(date)}
            {section ? ` · ${section}` : ""}
          </span>
          {published !== undefined && (
            <span className="kicker mt-0.5" style={{ color: "var(--color-faint)" }}>
              {published} published · {inProduction ?? 0} in production
            </span>
          )}
        </div>
      )}

      {/* Next (newer) edition → */}
      <div className="flex flex-1 items-center justify-end text-right">
        {next ? (
          <Link href={`/feed/${next}`} className="edition-nav-link justify-end">
            <span className="flex flex-col items-end">
              <span className="kicker" style={{ color: "var(--color-faint)" }}>Next</span>
              <span className="edition-nav-date">{formatShort(next)}</span>
            </span>
            <span className="edition-nav-arrow" aria-hidden>→</span>
          </Link>
        ) : (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>Latest edition</span>
        )}
      </div>
    </div>
  );
}
