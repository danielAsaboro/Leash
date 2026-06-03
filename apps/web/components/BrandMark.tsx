import Link from "next/link";

/**
 * The floating monogram, bottom-left — a quiet wordmark that links home and to
 * Mission Control. A mycelial spore "U" for The Understory.
 */
export function BrandMark() {
  return (
    <Link
      href="/mission-control"
      title="Mission Control"
      className="group fixed bottom-5 left-5 z-50 flex items-center gap-3"
    >
      <span
        className="flex items-center justify-center rounded-full transition-transform group-hover:scale-105"
        style={{
          width: 44,
          height: 44,
          background: "var(--color-ink)",
          color: "var(--color-cream)",
          fontFamily: "var(--font-display)",
          fontWeight: 900,
          fontSize: 24,
          boxShadow: "0 6px 22px rgba(25,23,18,0.28)",
        }}
      >
        U
      </span>
      <span
        className="kicker hidden opacity-0 transition-opacity group-hover:opacity-100 sm:inline"
        style={{ color: "var(--color-muted)" }}
      >
        Mission Control
      </span>
    </Link>
  );
}
