/** Typed reads for the reader + Mission Control. Server-only. */
import "server-only";
import { prisma } from "./db.ts";
import { Stage, type Section } from "@mycelium/db";

const IN_PROGRESS_STAGES = [Stage.RESEARCHING, Stage.RESEARCH_READY, Stage.DRAFTING];

export type ArticleCard = Awaited<ReturnType<typeof getEditionArticles>>[number];

/**
 * Published articles for a date in **publishedAt ASC** order — oldest first.
 *
 * Ascending is deliberate and load-bearing: the front-page compositor
 * (`lib/layout.ts`) keys each story's block size + position on its index, so a
 * permanent index means a permanent slot. The first story of the day becomes the
 * LEAD and stays there; new arrivals append to the end. (See `composeFrontPage`.)
 */
export async function getEditionArticles(date: string, section?: Section) {
  return prisma.article.findMany({
    where: {
      date,
      stage: Stage.PUBLISHED,
      ...(section ? { section } : {}),
    },
    orderBy: [{ publishedAt: "asc" }],
    select: {
      id: true,
      slug: true,
      date: true,
      section: true,
      origin: true,
      headline: true,
      dek: true,
      heroImagePath: true,
      publishedAt: true,
      _count: { select: { sources: true, claims: true } },
    },
  });
}

/** Everything still moving through the newsroom (the IN PRODUCTION strip). */
export async function getInProduction(date: string) {
  return prisma.article.findMany({
    where: { date, stage: { not: Stage.PUBLISHED } },
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true, slug: true, date: true, section: true, origin: true, headline: true, dek: true, stage: true },
  });
}

/** The masthead from DaemonState (configurable paper name). */
export async function getMasthead(): Promise<string> {
  const state = await prisma.daemonState.findUnique({ where: { id: 1 }, select: { masthead: true } });
  return state?.masthead ?? "The Understory";
}

/** The live daemon status (RUNNING | IDLE | STOPPED) for the masthead status dot. */
export async function getDaemonStatus(): Promise<string> {
  const state = await prisma.daemonState.findUnique({ where: { id: 1 }, select: { status: true } });
  return state?.status ?? "IDLE";
}

export type SearchHit = {
  id: string;
  date: string;
  slug: string;
  section: string;
  origin: string;
  headline: string;
  snippet: string;
};

/**
 * Full-text-ish search over PUBLISHED articles for the ⌘K palette. SQLite `LIKE`
 * (Prisma `contains`) is ASCII case-insensitive, so no `mode` needed. Matches in
 * headline / dek / body; returns a short snippet windowed around the body match.
 */
export async function searchArticles(query: string, take = 12): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await prisma.article.findMany({
    where: {
      stage: Stage.PUBLISHED,
      OR: [{ headline: { contains: q } }, { dek: { contains: q } }, { body: { contains: q } }],
    },
    orderBy: [{ publishedAt: "desc" }],
    take,
    select: { id: true, date: true, slug: true, section: true, origin: true, headline: true, dek: true, body: true },
  });
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    slug: r.slug,
    section: r.section,
    origin: r.origin,
    headline: r.headline,
    snippet: snippetAround(r.body || r.dek, q) || r.dek,
  }));
}

/** A ~150-char window of `text` centred on the first case-insensitive hit of `q`. */
function snippetAround(text: string, q: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const idx = clean.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return clean.slice(0, 150);
  const start = Math.max(0, idx - 60);
  const slice = clean.slice(start, start + 150);
  return (start > 0 ? "…" : "") + slice + (start + 150 < clean.length ? "…" : "");
}

/** Distinct edition dates, newest first. */
export async function getEditionDates(): Promise<string[]> {
  const eds = await prisma.edition.findMany({ orderBy: { date: "desc" }, select: { date: true } });
  return eds.map((e) => e.date);
}

/**
 * The neighbouring editions for date-pagination: `prev` is the closest *older*
 * edition, `next` the closest *newer* one (null at the ends). Works even when `date`
 * has no edition of its own (e.g. an empty "today"). YYYY-MM-DD sorts chronologically
 * as a string, so plain `lt`/`gt` ordering is correct.
 */
export async function getAdjacentEditions(date: string): Promise<{ prev: string | null; next: string | null }> {
  const [older, newer] = await Promise.all([
    prisma.edition.findFirst({ where: { date: { lt: date } }, orderBy: { date: "desc" }, select: { date: true } }),
    prisma.edition.findFirst({ where: { date: { gt: date } }, orderBy: { date: "asc" }, select: { date: true } }),
  ]);
  return { prev: older?.date ?? null, next: newer?.date ?? null };
}

/** One article with everything the page renders. */
export async function getArticle(date: string, slug: string) {
  return prisma.article.findUnique({
    where: { date_slug: { date, slug } },
    include: {
      sources: { orderBy: { order: "asc" } },
      claims: { orderBy: { order: "asc" } },
      dossier: true,
    },
  });
}

/** Per-section published counts for the category nav. */
export async function getSectionCounts(date: string): Promise<Record<string, number>> {
  const rows = await prisma.article.groupBy({
    by: ["section"],
    where: { date, stage: Stage.PUBLISHED },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.section] = r._count._all;
  return out;
}

/** Mission Control: the live daemon state, derived counts, the active assignment, telemetry. */
export async function getMissionControl() {
  const [state, byStage, recentRuns] = await Promise.all([
    prisma.daemonState.findUnique({ where: { id: 1 } }),
    prisma.article.groupBy({ by: ["stage"], _count: { _all: true } }),
    prisma.daemonRun.findMany({ orderBy: { id: "desc" }, take: 12 }),
  ]);

  const count = (stages: string[]) =>
    byStage.filter((r) => stages.includes(r.stage)).reduce((n, r) => n + r._count._all, 0);

  const counts = {
    queued: count([Stage.QUEUED]),
    inProgress: count(IN_PROGRESS_STAGES),
    needsReporting: count([Stage.REVIEW]),
    published: count([Stage.PUBLISHED]),
  };

  // The active assignment: the article currently being worked (in-flight or in review),
  // most recently touched. Falls back to the next queued story.
  const active =
    (await prisma.article.findFirst({
      where: { stage: { in: [...IN_PROGRESS_STAGES, Stage.REVIEW] } },
      orderBy: [{ startedAt: "desc" }, { updatedAt: "desc" }],
      include: { dossier: { select: { id: true } } },
    })) ??
    (await prisma.article.findFirst({
      where: { stage: Stage.QUEUED },
      orderBy: { createdAt: "asc" },
      include: { dossier: { select: { id: true } } },
    }));

  const lastDiscovery = recentRuns.find((r) => r.kind === "discovery" && r.finishedAt) ?? null;

  return { state, counts, active, recentRuns, lastDiscovery };
}

/** The dossier artifact for an article. */
export async function getDossier(date: string, slug: string) {
  const article = await prisma.article.findUnique({
    where: { date_slug: { date, slug } },
    include: { dossier: true, sources: { orderBy: { order: "asc" } } },
  });
  return article;
}
