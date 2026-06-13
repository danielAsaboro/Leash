"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { LeashMark } from "./LeashMark.tsx";
import { siteHome } from "../lib/site.ts";
import { activateAndGo } from "../lib/auth-handshake.ts";

async function signOut(): Promise<void> {
  await fetch("/api/leash/auth/logout", { method: "POST" });
  // logout drops the supervisor back to BOOTSTRAP (no active user); wait for that respawn
  // before landing on /login so we don't race a connection-refused.
  await activateAndGo(null, "/login");
}

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
function TasksIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="m3.5 6 1.5 1.5L8 4.5M3.5 12.5 5 14l3-3M3.5 19l1.5 1.5 3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 6.5H21M11.5 13H21M11.5 19.5H21" strokeLinecap="round" />
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

function MeshIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="5" cy="5.5" r="1.9" />
      <circle cx="19" cy="5.5" r="1.9" />
      <circle cx="5" cy="18.5" r="1.9" />
      <circle cx="19" cy="18.5" r="1.9" />
      <path d="M10.3 10.4 6.3 6.8M13.7 10.4l4-3.6M10.3 13.6l-4 3.6M13.7 13.6l4 3.6" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const ITEMS: { href: string; label: string; Icon: () => React.JSX.Element; isActive: (p: string) => boolean }[] = [
  { href: "/home", label: "Home", Icon: HomeIcon, isActive: (p) => p === "/home" },
  { href: "/chat", label: "Chat", Icon: ChatIcon, isActive: (p) => p.startsWith("/chat") },
  { href: "/feed", label: "Feed", Icon: PaperIcon, isActive: (p) => p.startsWith("/feed") },
  { href: "/brain", label: "Brain", Icon: BrainIcon, isActive: (p) => p.startsWith("/brain") },
  { href: "/tasks", label: "Tasks", Icon: TasksIcon, isActive: (p) => p.startsWith("/tasks") },
  { href: "/economy", label: "Economy", Icon: EconomyIcon, isActive: (p) => p.startsWith("/economy") },
  { href: "/mesh", label: "Mesh", Icon: MeshIcon, isActive: (p) => p.startsWith("/mesh") },
  { href: "/services", label: "Services", Icon: ServicesIcon, isActive: (p) => p.startsWith("/services") },
];

export function LeashRail() {
  const pathname = usePathname() ?? "/";
  // The logo points to the marketing home: the local landing in dev, the live domain in prod.
  // Set post-mount (SSR can't read the host) so the href never mismatches at hydration.
  const [home, setHome] = useState("https://useleash.xyz/");
  useEffect(() => setHome(siteHome()), []);
  const external = home.startsWith("http");

  // The landing (`/`) IS the marketing home — it provides its own masthead, so the app rail hides there.
  if (pathname === "/") return null;

  return (
    <nav className="leash-rail" aria-label="Leash">
      <a
        href={home}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="leash-rail-mark"
        title={external ? "useleash.xyz" : "Leash home"}
        aria-label="Leash home"
      >
        <LeashMark className="leash-rail-mark-icon" cutoutColor="var(--color-ink)" />
      </a>

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

      <Link href="/settings" className="leash-rail-foot" title="Settings" aria-label="Settings">
        <SettingsIcon />
      </Link>
      <button className="leash-rail-foot" title="Sign out" aria-label="Sign out" onClick={signOut}>
        <LogOut size={22} strokeWidth={1.7} aria-hidden />
      </button>
    </nav>
  );
}
