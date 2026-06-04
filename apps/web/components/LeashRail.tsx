"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The Leash shell's left rail — the app's primary nav.
 *
 * Leash is a personal on-device assistant; The Understory (the auto-written paper) is
 * one surface inside it. Live surfaces: **Chat** (the assistant) and **Paper** (the
 * broadsheet). **Home** (Home Assistant) and **Activity** (screen/AX watchers) are
 * honest *disabled* entries — real "Not configured" states, never fake panels — until
 * their daemon-side tools land (roadmap P2/P3). Fixed-position; the layout offsets the
 * main content by the rail width so the 100dvh reader sits beside it untouched.
 */

const DATE_RE = /^\/\d{4}-\d{2}-\d{2}(\/|$)/;

function ChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PaperIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 4h13v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" strokeLinejoin="round" />
      <path d="M17 8h3v10a2 2 0 0 1-2 2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 8h7M7 11.5h7M7 15h4" strokeLinecap="round" />
    </svg>
  );
}
function HomeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 10.5 12 4l8 6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 9.5V20h12V9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ActivityIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M3 12h4l2.5-7 5 14 2.5-7H21" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LeashRail() {
  const pathname = usePathname() ?? "/";
  const onChat = pathname.startsWith("/chat");
  const onPaper = pathname === "/paper" || DATE_RE.test(pathname);

  return (
    <nav className="leash-rail" aria-label="Leash">
      <Link href="/chat" className="leash-rail-mark" title="Leash">
        L
      </Link>

      <div className="leash-rail-nav">
        <Link href="/chat" className={`leash-rail-item ${onChat ? "is-active" : ""}`} aria-current={onChat ? "page" : undefined}>
          <ChatIcon />
          <span>Chat</span>
        </Link>
        <Link href="/paper" className={`leash-rail-item ${onPaper ? "is-active" : ""}`} aria-current={onPaper ? "page" : undefined}>
          <PaperIcon />
          <span>Paper</span>
        </Link>
        <div className="leash-rail-item is-disabled" title="Home Assistant — not configured" aria-disabled>
          <HomeIcon />
          <span>Home</span>
        </div>
        <div className="leash-rail-item is-disabled" title="Activity sensors — not configured" aria-disabled>
          <ActivityIcon />
          <span>Activity</span>
        </div>
      </div>

      <Link href="/mission-control" className="leash-rail-foot kicker" title="Mission Control">
        MC
      </Link>
    </nav>
  );
}
