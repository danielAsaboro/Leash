/**
 * Discovery (network-only step): poll the configured feeds, dedup against stories we
 * already track, and create QUEUED · EXTERNAL articles — one row per fresh headline,
 * with its feed link captured as the first Source. Drafting happens later, offline.
 */
import { prisma, Stage, Origin } from "@mycelium/db";
import { FEEDS, refineSection } from "./feeds.ts";
import { fetchFeed } from "./rss.ts";
import { today } from "./config.ts";
import { slugify, tidy } from "./util.ts";

export interface DiscoverResult {
  createdIds: string[];
  scanned: number;
  feedsOk: number;
}

/** Discover up to `limit` new external stories. Returns the created article ids. */
export async function discover(limit = 2): Promise<DiscoverResult> {
  const date = today();
  // Dedup set: every link we've already captured + every headline we already track.
  const existingSources = await prisma.source.findMany({ select: { url: true } });
  const seenUrls = new Set(existingSources.map((s) => s.url).filter(Boolean) as string[]);
  const existingArticles = await prisma.article.findMany({ select: { headline: true } });
  const seenTitles = new Set(existingArticles.map((a) => a.headline.toLowerCase()));

  const createdIds: string[] = [];
  let scanned = 0;
  let feedsOk = 0;

  for (const feed of FEEDS) {
    if (createdIds.length >= limit) break;
    let items;
    try {
      items = await fetchFeed(feed.url);
      feedsOk++;
    } catch {
      continue; // offline / feed down — skip, other feeds may still resolve
    }
    for (const item of items) {
      if (createdIds.length >= limit) break;
      scanned++;
      const title = tidy(item.title, 160);
      if (!title) continue;
      if (item.link && seenUrls.has(item.link)) continue;
      if (seenTitles.has(title.toLowerCase())) continue;

      const section = refineSection(feed.section, title);
      const article = await prisma.article.create({
        data: {
          slug: `${slugify(title)}-${Date.now().toString(36).slice(-4)}`,
          date,
          section,
          origin: Origin.EXTERNAL,
          headline: title,
          dek: tidy(item.summary, 200),
          stage: Stage.QUEUED,
          sources: {
            create: item.link
              ? [{ label: feed.name, url: item.link, kind: "rss", order: 0 }]
              : [{ label: feed.name, kind: "rss", order: 0 }],
          },
        },
      });
      createdIds.push(article.id);
      if (item.link) seenUrls.add(item.link);
      seenTitles.add(title.toLowerCase());
    }
  }
  return { createdIds, scanned, feedsOk };
}
