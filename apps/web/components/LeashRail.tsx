"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LeashMark } from "./LeashMark.tsx";

/**
 * The Leash shell's left rail — the app's primary nav.
 *
 * Leash is the project's full dashboard. Surfaces: **Home** (overview — serve, daemons,
 * tasks, disk), **Chat** (the assistant), **Paper** (The Understory broadsheet),
 * **Brain** (memory · skills · tools · prompts · models — everything the assistant is
 * made of), **Tasks** (tasks · pipeline · daemons). Every entry is a real, working
 * page — no disabled placeholders. Fixed-position; the layout offsets the main content
 * by the rail width so the 100dvh reader sits beside it untouched.
 */

const DATE_RE = /^\/\d{4}-\d{2}-\d{2}(\/|$)/;

function HomeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 10.5 12 4l8 6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 9.5V20h12V9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
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
function BrainIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 4.5a3 3 0 0 0-3-1.5 3 3 0 0 0-2.6 3.4A3.2 3.2 0 0 0 4 9.5a3.2 3.2 0 0 0 1 5.7A3 3 0 0 0 8 19a3 3 0 0 0 4 .9V4.5z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 4.5a3 3 0 0 1 3-1.5 3 3 0 0 1 2.6 3.4A3.2 3.2 0 0 1 20 9.5a3.2 3.2 0 0 1-1 5.7A3 3 0 0 1 16 19a3 3 0 0 1-4 .9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GrowIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 20h16" strokeLinecap="round" />
      <path d="m5 16 4-4 3 2.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 7h-3M19 7v3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function TasksIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="m3.5 6 1.5 1.5L8 4.5M3.5 12.5 5 14l3-3M3.5 19l1.5 1.5 3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 6.5H21M11.5 13H21M11.5 19.5H21" strokeLinecap="round" />
    </svg>
  );
}
function ResearchIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="11" cy="11" r="6.5" strokeLinecap="round" />
      <path d="m16 16 4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}
function ServicesIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M6 6l1.9 1.9M16.1 16.1 18 18M18 6l-1.9 1.9M7.9 16.1 6 18" strokeLinecap="round" />
    </svg>
  );
}
function EconomyIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" strokeLinejoin="round" />
      <path d="M5 6v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 11v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="12" cy="12" r="3" strokeLinejoin="round" />
      <path d="M12 2.5v2.3M12 19.2v2.3M21.5 12h-2.3M4.8 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" strokeLinecap="round" />
    </svg>
  );
}

const ITEMS: { href: string; label: string; Icon: () => React.JSX.Element; isActive: (p: string) => boolean }[] = [
  { href: "/home", label: "Home", Icon: HomeIcon, isActive: (p) => p === "/home" },
  { href: "/chat", label: "Chat", Icon: ChatIcon, isActive: (p) => p.startsWith("/chat") },
  { href: "/paper", label: "Paper", Icon: PaperIcon, isActive: (p) => p === "/paper" || DATE_RE.test(p) },
  { href: "/brain", label: "Brain", Icon: BrainIcon, isActive: (p) => p.startsWith("/brain") },
  { href: "/grow", label: "Grow", Icon: GrowIcon, isActive: (p) => p.startsWith("/grow") },
  { href: "/tasks", label: "Tasks", Icon: TasksIcon, isActive: (p) => p.startsWith("/tasks") },
  { href: "/research", label: "Research", Icon: ResearchIcon, isActive: (p) => p.startsWith("/research") },
  { href: "/economy", label: "Economy", Icon: EconomyIcon, isActive: (p) => p.startsWith("/economy") },
  { href: "/services", label: "Services", Icon: ServicesIcon, isActive: (p) => p.startsWith("/services") },
  { href: "/settings", label: "Settings", Icon: SettingsIcon, isActive: (p) => p.startsWith("/settings") },
];

export function LeashRail() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="leash-rail" aria-label="Leash">
      <Link href="/chat" className="leash-rail-mark" title="Leash" aria-label="Leash">
        <LeashMark className="leash-rail-mark-icon" cutoutColor="var(--color-ink)" />
      </Link>

      <div className="leash-rail-nav">
        {ITEMS.map(({ href, label, Icon, isActive }) => {
          const active = isActive(pathname);
          return (
            <Link key={href} href={href} className={`leash-rail-item ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined}>
              <Icon />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>

      <Link href="/mission-control" className="leash-rail-foot kicker" title="Mission Control">
        MC
      </Link>
    </nav>
  );
}
