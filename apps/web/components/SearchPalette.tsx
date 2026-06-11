"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sectionKicker } from "../lib/ui.ts";

/** A window event both the nav magnifier and the global ⌘K hotkey dispatch to open. */
const OPEN_EVENT = "understory:open-search";

type Hit = {
  id: string;
  date: string;
  slug: string;
  section: string;
  origin: string;
  headline: string;
  snippet: string;
};

/** The nav-row magnifier. Opens the shared palette via a window event + shows a ⌘K hint. */
export function SearchTrigger() {
  return (
    <button
      type="button"
      aria-label="Search the archive"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className="group inline-flex items-center gap-2 transition-colors"
      style={{ color: "var(--color-muted)" }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <span className="kicker hidden sm:inline" style={{ color: "var(--color-faint)" }}>
        ⌘K
      </span>
    </button>
  );
}

/**
 * The ⌘K command palette — a cream overlay with a mono input, debounced search over
 * PUBLISHED articles, and serif result rows. Mounted once (in the root layout); opened
 * by the nav magnifier *or* ⌘K / Ctrl-K. ↑/↓ moves, Enter navigates, Esc closes.
 */
export function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHits([]);
    setActive(0);
  }, []);

  // Open via the nav magnifier (event) and via the global ⌘K / Ctrl-K hotkey.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Focus the input + lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Debounced fetch. A request id guards against out-of-order responses.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let stale = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { hits: Hit[] };
        if (!stale) {
          setHits(data.hits);
          setActive(0);
        }
      } catch {
        if (!stale) setHits([]);
      } finally {
        if (!stale) setLoading(false);
      }
    }, 180);
    return () => {
      stale = true;
      window.clearTimeout(id);
    };
  }, [query, open]);

  const go = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return;
      close();
      router.push(`/feed/${hit.date}/${hit.slug}`);
    },
    [router, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(hits[active]);
    }
  };

  if (!open) return null;

  return (
    <div className="search-overlay" onMouseDown={close}>
      <div className="search-panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="search-input-row">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ color: "var(--color-muted)" }}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the archive…"
            className="search-input"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="search-kbd">Esc</kbd>
        </div>

        {query.trim().length >= 2 && (
          <ul className="search-results">
            {hits.length === 0 && !loading && (
              <li className="search-empty kicker">No stories match “{query.trim()}”.</li>
            )}
            {hits.map((h, i) => (
              <li key={h.id}>
                <button
                  type="button"
                  className={`search-row ${i === active ? "is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                >
                  <span className="kicker kicker-sage">{sectionKicker(h.section, h.origin)}</span>
                  <span className="search-headline">{h.headline}</span>
                  <span className="search-snippet">{h.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="search-foot kicker">
          <span><kbd className="search-kbd">↑↓</kbd> move</span>
          <span><kbd className="search-kbd">↵</kbd> open</span>
          <span><kbd className="search-kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
