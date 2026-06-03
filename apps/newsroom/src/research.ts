/**
 * Research: turn a QUEUED article into a RESEARCH_READY one with an embedded pack.
 *
 *  - PERSONAL briefs already arrive with their pack (the graph nodes) on the Dossier;
 *    research just embeds it into the article's private RAG workspace.
 *  - EXTERNAL stories carry only a feed link: research fetches the readable page text
 *    (network step), assembles {feed summary + page text} into the pack, and embeds it.
 *
 * After this step the article is grounded and every later step is fully offline.
 */
import { prisma, Stage } from "@mycelium/db";
import { persistPack, type ResearchPack, type PackSource } from "./pack.ts";
import { fetchReadable } from "./rss.ts";
import { tidy } from "./util.ts";
import type { Newsroom } from "./context.ts";

export async function research(nr: Newsroom, articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({
    where: { id: articleId },
    include: { sources: { orderBy: { order: "asc" } }, dossier: true },
  });
  await prisma.article.update({ where: { id: articleId }, data: { stage: Stage.RESEARCHING, startedAt: article.startedAt ?? new Date() } });

  let pack: ResearchPack;
  if (article.dossier) {
    // PERSONAL brief: pack was pre-assembled from the private graph.
    pack = JSON.parse(article.dossier.research) as ResearchPack;
  } else {
    // EXTERNAL: fetch each feed source's readable text (best-effort) into the pack.
    const sources: PackSource[] = [];
    for (const s of article.sources) {
      const readable = s.url ? await fetchReadable(s.url) : "";
      const text = tidy([article.dek, readable].filter(Boolean).join(" — "), 4000) || article.headline;
      sources.push({ label: s.label, url: s.url ?? undefined, kind: "web", text });
    }
    if (sources.length === 0) sources.push({ label: article.headline, kind: "web", text: article.dek || article.headline });
    pack = { topic: article.headline, sources };
  }

  await persistPack(nr, articleId, pack);
  await prisma.article.update({ where: { id: articleId }, data: { stage: Stage.RESEARCH_READY } });
}
