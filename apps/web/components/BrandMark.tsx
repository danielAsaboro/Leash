import Image from "next/image";
import Link from "next/link";

/**
 * The floating Leash mark, bottom-left — a quiet bridge to the feed.
 */
export function BrandMark() {
  return (
    <Link
      href="/feed"
      title="Feed"
      aria-label="Feed"
      className="group fixed bottom-5 left-5 z-50 flex items-center gap-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-sage-deep)]"
    >
      <Image
        src="/icon-512.png"
        alt=""
        width={44}
        height={44}
        priority
        className="rounded-[22%] transition-transform group-hover:scale-105"
        style={{ boxShadow: "0 6px 22px rgba(25,23,18,0.28)" }}
      />
      <span
        className="kicker hidden opacity-0 transition-opacity group-hover:opacity-100 sm:inline"
        style={{ color: "var(--color-muted)" }}
      >
        Feed
      </span>
    </Link>
  );
}
