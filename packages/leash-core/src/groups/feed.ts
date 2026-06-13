/**
 * Feed tool group — search the user's auto-written on-device daily paper (The Understory).
 * Reads PUBLISHED articles from the newsroom SQLite DB (WAL mode → safe multi-process
 * reads). Tool names stay `understory_*` for stored-thread back-compat; the SERVER is "Feed".
 */
import { z } from "zod";
import { prisma, Stage } from "@mycelium/db";
import { oneLine, type LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

export const feedGroup: ToolGroup = {
  id: "feed",
  label: "Feed",
  description: "Search the user's auto-written on-device daily paper (The Understory) — published articles and the latest edition's headlines.",
  tools: [
    defineTool({
      name: "understory_search",
      description:
        "Search The Understory — the user's auto-written, on-device daily paper — for PUBLISHED articles relevant to a query. Use for questions about what the paper has covered.",
      inputSchema: {
        query: z.string().describe("What to look for across headlines, deks, and bodies."),
        topK: z.number().int().min(1).max(12).optional().describe("How many articles (default 5)."),
      },
      handler: async ({ query, topK }) => {
        const q = query.trim();
        if (q.length < 2) return { text: "Provide a search query of at least 2 characters.", sources: [] as LeashSource[] };
        const rows = await prisma.article.findMany({
          where: { stage: Stage.PUBLISHED, OR: [{ headline: { contains: q } }, { dek: { contains: q } }, { body: { contains: q } }] },
          orderBy: [{ publishedAt: "desc" }],
          take: topK ?? 5,
          select: { date: true, slug: true, headline: true, dek: true },
        });
        const sources: LeashSource[] = rows.map((r) => ({ kind: "paper", title: r.headline, snippet: oneLine(r.dek), url: `/feed/${r.date}/${r.slug}` }));
        return {
          text: rows.length ? rows.map((r) => `(${r.date}) ${r.headline} — ${oneLine(r.dek)}`).join("\n") : `No published articles match "${q}".`,
          sources,
        };
      },
    }),

    defineTool({
      name: "understory_today",
      description: "List the headlines published in the LATEST edition of The Understory. Use when asked what's in today's paper / today's news.",
      inputSchema: {},
      handler: async () => {
        const latest = await prisma.article.findFirst({ where: { stage: Stage.PUBLISHED }, orderBy: [{ date: "desc" }], select: { date: true } });
        if (!latest) return { text: "The Understory has no published editions yet.", sources: [] as LeashSource[] };
        const rows = await prisma.article.findMany({
          where: { stage: Stage.PUBLISHED, date: latest.date },
          orderBy: [{ publishedAt: "asc" }],
          select: { date: true, slug: true, headline: true, dek: true },
        });
        const sources: LeashSource[] = rows.map((r) => ({ kind: "paper", title: r.headline, snippet: oneLine(r.dek), url: `/feed/${r.date}/${r.slug}` }));
        return {
          text: `The Understory — latest edition (${latest.date}), ${rows.length} stories:\n` + rows.map((r) => `${r.headline} — ${oneLine(r.dek)}`).join("\n"),
          sources,
        };
      },
    }),
  ],
};
