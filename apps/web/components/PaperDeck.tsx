"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PageChip } from "../lib/layout.ts";
import { StageTracker } from "./StageTracker.tsx";

/** A serializable in-production chip — a story still moving through the newsroom. */
export type PendingChip = { id: string; kicker: string; headline: string; stage: string };

/**
 * The reader shell: a horizontal `scroll-snap` deck of server-rendered broadsheet
 * pages (`children`), plus a sticky bottom **page-bar** built from `chips`.
 *
 * - The active page is tracked off the scroller's position and its chip is highlighted.
 * - Clicking a chip or the ←/→ arrows snaps the deck to that page in place — no reload.
 * - Pages that appeared since the last visit (tracked as a count in `localStorage`)
 *   briefly ring their chip — this subsumes the old JUST IN band.
 * - In-production stories trail the bar as ghosted `is-pending` chips, so the reader
 *   sees what's coming. New pages mount at the end on `router.refresh()`; the active
 *   page and scroll position are preserved (stable component identity).
 */
export function PaperDeck({
  chips,
  pending = [],
  date,
  children,
}: {
  chips: PageChip[];
  pending?: PendingChip[];
  date: string;
  children: ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(1);
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  const total = chips.length;

  // Track the active page from the scroller position: the last page whose left edge
  // has crossed the viewport mid-line. Robust under scroll-snap and resize.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const mid = scroller.scrollLeft + scroller.clientWidth / 2;
      let n = 1;
      scroller.querySelectorAll<HTMLElement>("[data-page-n]").forEach((p) => {
        if (p.offsetLeft <= mid) n = Number(p.dataset.pageN);
      });
      setActive(n);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [total]);

  // Ring chips for pages that appeared while away (or live, mid-session). First visit
  // seeds the count silently so there's no flash storm.
  useEffect(() => {
    if (!date || total === 0) return;
    const key = `understory:pages:${date}`;
    let seen = 0;
    try {
      seen = Number(localStorage.getItem(key) ?? "0");
    } catch {
      seen = 0;
    }
    const persist = () => {
      try {
        localStorage.setItem(key, String(total));
      } catch {
        /* private mode / quota — degrade to no-flash, never throw */
      }
    };
    if (seen === 0 || seen >= total) {
      persist();
      return;
    }
    const ring = new Set<number>();
    for (let n = seen + 1; n <= total; n++) ring.add(n);
    setFresh(ring);
    persist();
    const t = window.setTimeout(() => setFresh(new Set()), 6000);
    return () => window.clearTimeout(t);
  }, [total, date]);

  const goTo = useCallback((n: number) => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-page-n="${n}"]`);
    el?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }, []);

  // Keep the active chip in view within the bar as the deck scrolls.
  useEffect(() => {
    barRef.current
      ?.querySelector<HTMLElement>(`[data-chip-n="${active}"]`)
      ?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [active]);

  const atStart = active <= 1;
  const atEnd = active >= total;

  return (
    <div className="paper-deck">
      <div className="paper-deck-scroller" ref={scrollerRef}>
        {children}
      </div>

      <div className="page-bar">
        <button
          type="button"
          className="page-bar-arrow"
          onClick={() => goTo(active - 1)}
          disabled={atStart}
          aria-label="Previous page"
        >
          ←
        </button>

        <div className="page-bar-track" ref={barRef}>
          {chips.map((c) => (
            <button
              key={c.n}
              type="button"
              data-chip-n={c.n}
              className={`page-chip${c.n === active ? " is-active" : ""}${fresh.has(c.n) ? " just-in-flash" : ""}`}
              onClick={() => goTo(c.n)}
            >
              <span className="page-chip-no">Page {c.n}</span>
              <span
                className="page-chip-kicker"
                style={c.bulletin ? { color: "var(--color-brick)", fontWeight: 600 } : undefined}
              >
                {c.bulletin ? `📌 ${c.kicker}` : c.kicker}
              </span>
              <span className="page-chip-headline">{c.headline}</span>
            </button>
          ))}

          {pending.map((p) => (
            <div key={p.id} className="page-chip is-pending" aria-label={`In production: ${p.headline}`}>
              <span className="page-chip-no">In Production</span>
              <span className="page-chip-kicker">{p.kicker}</span>
              <span className="page-chip-headline">{p.headline}</span>
              <span className="page-chip-stage">
                <StageTracker stage={p.stage} />
              </span>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="page-bar-arrow"
          onClick={() => goTo(active + 1)}
          disabled={atEnd}
          aria-label="Next page"
        >
          →
        </button>
      </div>
    </div>
  );
}
