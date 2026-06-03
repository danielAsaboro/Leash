"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/** A serializable arrival — everything the band needs, no Date objects. */
export type LiveItem = {
  id: string;
  date: string;
  slug: string;
  section: string;
  headline: string;
  kicker: string;
  bulletin: boolean;
  publishedAt: number; // epoch ms
};

/**
 * The live layer over a frozen mosaic. The server renders the day's blocks in fixed
 * positions; this client tracks **seen ids in localStorage** (per edition) and, on a
 * refresh that brings stories it hasn't seen, pops them into a slim `⚡ JUST IN` band
 * and flashes their matching mosaic card (`[data-article-id]`) for ~6s. Nothing
 * already on the page moves — only the band updates.
 *
 * First-ever visit to an edition seeds *everything* as seen, so there's no flash storm
 * on load; subsequent visits surface whatever published "while you were away".
 */
export function LiveFront({ items }: { items: LiveItem[] }) {
  const date = items[0]?.date ?? "";
  const seenRef = useRef<Set<string> | null>(null);
  const [justIn, setJustIn] = useState<LiveItem[]>([]);

  useEffect(() => {
    if (!date) return; // empty edition — defer init until real stories exist
    const key = `understory:seen:${date}`;
    const persist = (s: Set<string>) => {
      try {
        localStorage.setItem(key, JSON.stringify([...s]));
      } catch {
        /* private mode / quota — degrade to no-band, never throw */
      }
    };

    // One-time init: hydrate the seen-set, seeding everything on a first-ever visit.
    if (seenRef.current === null) {
      let stored: string[] | null = null;
      try {
        const raw = localStorage.getItem(key);
        stored = raw ? (JSON.parse(raw) as string[]) : null;
      } catch {
        stored = null;
      }
      if (stored === null) {
        seenRef.current = new Set(items.map((i) => i.id));
        persist(seenRef.current);
        return; // nothing is "new" on first contact
      }
      seenRef.current = new Set(stored);
    }

    const seen = seenRef.current;
    const fresh = items.filter((i) => !seen.has(i.id));
    if (fresh.length === 0) return;

    fresh.forEach((i) => seen.add(i.id));
    persist(seen);

    setJustIn((prev) => {
      const byId = new Map<string, LiveItem>();
      for (const it of [...fresh, ...prev]) if (!byId.has(it.id)) byId.set(it.id, it);
      return [...byId.values()].sort((a, b) => b.publishedAt - a.publishedAt);
    });

    // Flash each new story's mosaic card (restart the animation if already ringed).
    requestAnimationFrame(() => {
      for (const i of fresh) {
        document.querySelectorAll<HTMLElement>(`[data-article-id="${i.id}"]`).forEach((el) => {
          el.classList.remove("just-in-flash");
          void el.offsetWidth;
          el.classList.add("just-in-flash");
          window.setTimeout(() => el.classList.remove("just-in-flash"), 6000);
        });
      }
    });
  }, [items, date]);

  if (justIn.length === 0) return null;

  return (
    <div className="just-in-band">
      <div className="mx-auto flex max-w-[1180px] items-center gap-4 px-5 py-2.5">
        <span className="just-in-label kicker">⚡ Just In</span>
        <span className="just-in-pill">{justIn.length} new</span>
        <ul className="just-in-track">
          {justIn.map((i) => (
            <li key={i.id} className="just-in-item">
              <Link href={`/${i.date}/${i.slug}`} className="group inline-flex items-baseline gap-2">
                <span
                  className="kicker"
                  style={{ color: i.bulletin ? "var(--color-brick)" : "var(--color-sage-deep)", fontWeight: 600 }}
                >
                  {i.bulletin ? `📌 ${i.kicker}` : i.kicker}
                </span>
                <span
                  className="transition-opacity group-hover:opacity-60"
                  style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "0.98rem", lineHeight: 1.15 }}
                >
                  {i.headline}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
