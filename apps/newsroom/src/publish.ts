/**
 * Publish: attach the finished article to today's Edition, finalize a human slug
 * (unique within the date), and flip it to PUBLISHED. The edition is the /[date]
 * homepage; the slug is the /[date]/[slug] permalink.
 */
import { prisma, Stage } from "@mycelium/db";
import { slugify } from "./util.ts";

/** Ensure an Edition row exists for the date and return its id. */
async function ensureEdition(date: string): Promise<number> {
  const edition = await prisma.edition.upsert({ where: { date }, create: { date }, update: {} });
  return edition.id;
}

/** A slug unique within the article's date (appends -2, -3, … on collision). */
async function uniqueSlug(date: string, headline: string, selfId: string): Promise<string> {
  const base = slugify(headline);
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const clash = await prisma.article.findFirst({ where: { date, slug, NOT: { id: selfId } } });
    if (!clash) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

export async function publish(articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  const editionId = await ensureEdition(article.date);
  const slug = await uniqueSlug(article.date, article.headline, articleId);
  await prisma.article.update({
    where: { id: articleId },
    data: { editionId, slug, stage: Stage.PUBLISHED, publishedAt: new Date() },
  });
}
