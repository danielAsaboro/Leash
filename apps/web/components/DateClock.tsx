"use client";
import { useEffect, useState } from "react";

/**
 * Live ticking dateline (mono), e.g. `Tuesday, June 2, 2026, 5:50:21 PM`. Sits
 * top-right in the masthead rail, matching the broadsheet reference. Hydration-safe
 * (renders nothing until mounted, so server/client never disagree on the wall clock).
 */
export function DateClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const stamp = now
    ? now.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      })
    : " ";

  return (
    <span className="kicker" style={{ color: "var(--color-ink-soft)" }} suppressHydrationWarning>
      {stamp}
    </span>
  );
}
