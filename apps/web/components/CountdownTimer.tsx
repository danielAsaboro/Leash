"use client";
import { useEffect, useState } from "react";

/**
 * The big NEXT DISCOVERY countdown on Mission Control. Counts down to `target`
 * (ISO). When it lapses it shows "DUE" until the next server refresh moves the
 * target forward (LiveRefresh drives that).
 */
export function CountdownTimer({ target }: { target: string | null }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!target) {
      setRemaining(null);
      return;
    }
    const end = new Date(target).getTime();
    const update = () => setRemaining(Math.max(0, end - Date.now()));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (remaining === null) {
    return <span style={{ color: "var(--color-faint)" }}>—:—:—</span>;
  }
  if (remaining === 0) {
    return <span style={{ color: "var(--color-glow)" }}>DUE</span>;
  }

  const s = Math.floor(remaining / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return (
    <span suppressHydrationWarning style={{ color: "var(--color-glow)", fontVariantNumeric: "tabular-nums" }}>
      {hh}:{mm}:{ss}
    </span>
  );
}
