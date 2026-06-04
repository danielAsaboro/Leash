/**
 * The paper compositor — a *dynamic, per-day, strictly append-only* multi-page
 * broadsheet.
 *
 * The exocortex publishes stories at any hour while the daemon runs. Sorting
 * newest-first would reshuffle the whole paper on every arrival — destructive. So
 * instead we paginate the day's stories into **pages of fixed slot capacity where a
 * story's page and role depend only on its own index, never on the total count.**
 * Appending story N+1 therefore cannot move stories 0…N to a different page. That is
 * what makes the day append-only: a new story fills the current last page until it's
 * full, then spills onto a freshly appended page on the right — existing pages never
 * reorder or reflow.
 *
 * Input is the day's PUBLISHED stories in **publishedAt ASC** order (so index — and
 * thus page assignment — is permanent). Index 0 is always the page-1 LEAD.
 */
import { sectionKicker, isBulletin } from "./ui.ts";

/** A story's scale within its page. */
export type PaperRole = "lead" | "feature" | "column";

/** One story placed on a page, with its permanent role for the day. */
export interface PaperStory<A> {
  article: A;
  role: PaperRole;
}

/** One broadsheet page: its number, its layout seed, and the stories it carries. */
export interface PaperPage<A> {
  n: number;
  /** Deterministic per-page seed → picks the broadsheet template variant for the page. */
  seed: number;
  stories: PaperStory<A>[];
}

/** A page-bar chip: page number + the lead/feature kicker & headline, brick if any bulletin. */
export interface PageChip {
  n: number;
  kicker: string;
  headline: string;
  bulletin: boolean;
}

/**
 * Slot weights drive append-only pagination. The lead (index 0) is worth two slots;
 * every other story is worth one. A page holds `PAGE_CAPACITY` weight units. Because
 * the weight depends only on a story's index, the page boundaries are permanent:
 * page 1 = lead(2) + two columns(1+1) = 3 stories; every later page = four columns.
 */
const PAGE_CAPACITY = 4;
const weightOf = (index: number): number => (index === 0 ? 2 : 1);

/** A tiny stable string hash (FNV-1a, 32-bit) so the seed is deterministic per date. */
export function hashDate(date: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The per-page layout seed — the day's seed folded with the page number (golden-ratio mix). */
function pageSeed(date: string, n: number): number {
  return (hashDate(date) ^ Math.imul(n, 0x9e3779b1)) >>> 0;
}

/**
 * Paginate the day's published stories into an append-only sequence of broadsheet
 * pages plus the page-bar chips.
 *
 * @param articles day's PUBLISHED stories, **publishedAt ASC** (oldest = permanent LEAD)
 * @param date     the edition's YYYY-MM-DD key — seeds each page's template variant
 */
export function composePaper<
  A extends { section: string; origin: string; headline: string; dek?: string | null },
>(articles: A[], date: string): { pages: PaperPage<A>[]; chips: PageChip[] } {
  const pages: PaperPage<A>[] = [];
  if (articles.length === 0) return { pages, chips: [] };

  let current: PaperStory<A>[] = [];
  let weight = 0;
  let pageNo = 1;

  const flush = () => {
    pages.push({ n: pageNo, seed: pageSeed(date, pageNo), stories: current });
    pageNo++;
    current = [];
    weight = 0;
  };

  articles.forEach((article, i) => {
    const w = weightOf(i);
    // Start a fresh page when the next story would overflow the current one. This
    // depends only on earlier stories' weights (= their indices), never on the total.
    if (current.length > 0 && weight + w > PAGE_CAPACITY) flush();

    // Role is positional, so it's as permanent as the page assignment: index 0 opens
    // page 1 as the LEAD; the first story of every later page is a FEATURE; the rest
    // are COLUMNs.
    const role: PaperRole = i === 0 ? "lead" : current.length === 0 ? "feature" : "column";
    current.push({ article, role });
    weight += w;
  });
  if (current.length > 0) flush();

  const chips: PageChip[] = pages.map((p) => {
    const head = p.stories[0]!.article;
    return {
      n: p.n,
      kicker: sectionKicker(head.section, head.origin),
      headline: head.headline,
      bulletin: p.stories.some((s) => isBulletin(s.article)),
    };
  });

  return { pages, chips };
}
