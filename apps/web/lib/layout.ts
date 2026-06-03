/**
 * The front-page compositor — a *dynamic, per-day, strictly append-only* newspaper
 * layout.
 *
 * The exocortex publishes stories at any hour while the daemon runs. Sorting
 * newest-first would reshuffle the whole page on every arrival — destructive. So
 * instead we lay the day's stories into a fixed mosaic where **a story's block size
 * and position depend only on its own index + a per-day seed, never on the total
 * count.** Appending story N+1 therefore cannot move or resize blocks 0…N. That is
 * what makes today's page append-only: once laid out, a block stays put for the day,
 * and fresh arrivals simply tile onto the end (and pop into the JUST IN band).
 *
 * Input is the day's PUBLISHED stories in **publishedAt ASC** order (so index — and
 * thus position — is permanent). Index 0 is always the full-width LEAD; indices 1…
 * follow a date-seeded span sequence over a 6-column grid.
 */

/** A card scale. `lead` is the full-width hero; the rest tile the 6-col mosaic. */
export type BlockSize = "lead" | "feature" | "column" | "brief";

/** One composed block: the article plus its permanent geometry for the day. */
export interface Block<A> {
  article: A;
  size: BlockSize;
  /** Desktop column span over the 6-col grid (1 for the full-width lead row marker). */
  span: number;
  /** Starting column (0–5) of this block in its row — used to drop the left hairline. */
  col: number;
  /** True when this block opens a new row (no left column-rule). */
  firstInRow: boolean;
}

/**
 * Span sequences for indices 1…, each tiling cleanly to a 6-column grid (every row
 * sums to exactly 6), so the mosaic never overflows or leaves a ragged break mid-row.
 * The day's seed picks one — the rhythm differs day to day but is stable within a day.
 */
const VARIANTS: number[][] = [
  [3, 3, 2, 2, 2], // A — twin features, then a triplet of columns
  [4, 2, 3, 3], //    B — a dominant feature + sidebar, then a pair of halves
  [2, 4, 2, 2, 2], // C — a sidebar + dominant feature, then a triplet
  [3, 3, 3, 3], //    D — an even four-up of half-features
  [2, 2, 2, 4, 2], // E — a triplet, then a feature + tail
];

const GRID_COLS = 6;

/** A tiny stable string hash (FNV-1a, 32-bit) so the seed is deterministic per date. */
function hashDate(date: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pick the day's span rhythm from its date — deterministic, no Date.now(). */
export function variantForDate(date: string): number[] {
  return VARIANTS[hashDate(date) % VARIANTS.length]!;
}

/** Map a column span (and the story's own shape) to a card scale. */
function sizeForSpan(span: number, section: string): BlockSize {
  if (span >= 3) return "feature";
  // span === 2 → a compact unit. BRIEF stories read as no-image briefs.
  return section === "BRIEF" ? "brief" : "column";
}

/**
 * Compose the day's published stories into an append-only mosaic.
 *
 * @param articles day's PUBLISHED stories, **publishedAt ASC** (oldest = permanent LEAD)
 * @param date     the edition's YYYY-MM-DD key — seeds the span rhythm
 */
export function composeFrontPage<A extends { section: string }>(
  articles: A[],
  date: string,
): { lead: Block<A> | null; blocks: Block<A>[] } {
  if (articles.length === 0) return { lead: null, blocks: [] };

  const [head, ...rest] = articles;
  const lead: Block<A> = { article: head!, size: "lead", span: GRID_COLS, col: 0, firstInRow: true };

  const variant = variantForDate(date);
  const blocks: Block<A>[] = [];
  let col = 0; // running column cursor (0–5)

  rest.forEach((article, i) => {
    // Span depends ONLY on this item's index + the day's variant — never on the
    // total — so later appends can't change an earlier block. This is the invariant.
    const span = variant[i % variant.length]!;

    // Wrap to a fresh row if this block wouldn't fit. (The variants tile cleanly, so
    // this is a safety net; it still depends only on earlier spans, never on count.)
    if (col + span > GRID_COLS) col = 0;

    blocks.push({
      article,
      size: sizeForSpan(span, article.section),
      span,
      col,
      firstInRow: col === 0,
    });

    col += span;
    if (col >= GRID_COLS) col = 0;
  });

  return { lead, blocks };
}
