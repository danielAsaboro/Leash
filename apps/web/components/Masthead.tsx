import Link from "next/link";
import { DateClock } from "./DateClock.tsx";
import { StatusDot } from "./StatusDot.tsx";

/**
 * The broadsheet nameplate. Big Fraunces title between hairline flourishes, the live
 * dateline top-right, and a `● Running` daemon status beside the title (fed by
 * `DaemonState.status`). `size="compact"` is the smaller nameplate used on interior
 * (article/dossier) pages, where status is omitted.
 */
export function Masthead({
  masthead,
  tagline = "A private paper of what lies beneath your day",
  size = "full",
  href = "/",
  status,
}: {
  masthead: string;
  tagline?: string;
  size?: "full" | "compact";
  href?: string;
  status?: string;
}) {
  const full = size === "full";
  const showStatus = full && status !== undefined;
  return (
    <header className="relative z-10">
      {/* Top rail — dateline pinned right (matches the reference broadsheet). */}
      <div className="mx-auto flex max-w-[1180px] items-center justify-end px-5 pt-5">
        <DateClock />
      </div>

      <div className="mx-auto max-w-[1180px] px-5">
        <div className={`flex items-center gap-4 ${full ? "pt-6" : "pt-4"}`}>
          <span className="hidden h-px flex-1 sm:block" style={{ background: "var(--color-rule-strong)" }} />
          <Link
            href={href}
            className="block text-center"
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              lineHeight: 0.92,
              letterSpacing: full ? "-0.01em" : "-0.005em",
              fontSize: full ? "clamp(2.6rem, 8vw, 6rem)" : "clamp(1.6rem,4vw,2.4rem)",
            }}
          >
            {masthead}
          </Link>
          {/* Right flourish carries the status dot so the title stays optically centered. */}
          <span className="hidden flex-1 items-center gap-4 sm:flex">
            <span className="h-px flex-1" style={{ background: "var(--color-rule-strong)" }} />
            {showStatus && <StatusDot status={status!} />}
          </span>
        </div>

        {full && (
          <p
            className="mt-3 text-center italic"
            style={{ fontFamily: "var(--font-body)", color: "var(--color-muted)", fontSize: "1.02rem" }}
          >
            {tagline}
          </p>
        )}

        {/* Mobile: the status dot can't ride the (hidden) flourish — center it here. */}
        {showStatus && (
          <div className="mt-3 flex justify-center sm:hidden">
            <StatusDot status={status!} />
          </div>
        )}

        <div className={`${full ? "mt-5" : "mt-3"} border-t-2`} style={{ borderColor: "var(--color-ink)" }} />
        <div className="mt-[3px] border-t" style={{ borderColor: "var(--color-ink)" }} />
      </div>
    </header>
  );
}
