/**
 * Leash's AI SDK tool registry (server-only) — all real, no mocks.
 *
 *   search_graph      — the user's private notes (RAG over QVAC embeddings)
 *   understory_search — published articles in The Understory (the user's paper)
 *   understory_today  — the latest edition's headlines
 *   now               — current local date/time
 *
 * Each tool returns `{ text, sources }`: `text` is what the model reads to compose its
 * answer; `sources` is the structured citation list the UI renders (AI Elements Sources).
 * Home Assistant / activity watchers join later as MCP tools (see `mcp.ts`) — merged
 * into this set with zero changes here.
 */
import "server-only";
import { tool, experimental_generateImage as generateImage } from "ai";
import { z } from "zod";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, Stage } from "@mycelium/db";
import { searchNotes } from "./graph.ts";
import { imageModel } from "./provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → apps/web/public/leash-gen (Next serves /leash-gen/*). */
const GEN_DIR = join(here, "..", "..", "public", "leash-gen");
/** apps/web/lib/leash → repo root → data/leash-photo-tags.json (written by `npm run tag-photos`). */
const PHOTO_TAGS = process.env["LEASH_PHOTO_TAGS"] ?? join(here, "..", "..", "..", "..", "data", "leash-photo-tags.json");

interface PhotoTag {
  file: string;
  label: string;
  confidence: number;
  isDocument: boolean;
}

/** A citation surfaced to the UI. */
export interface LeashSource {
  kind: "graph" | "paper";
  title: string;
  snippet: string;
  /** In-app link for paper sources (`/<date>/<slug>`). */
  url?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export const leashTools = {
  search_graph: tool({
    description:
      "Search the user's private context graph (their personal notes, files, and voice memos) for passages relevant to a query. Call this whenever answering needs private facts about the user, their devices, projects, or preferences — do not guess.",
    inputSchema: z.object({
      query: z.string().describe("Natural-language description of the information needed."),
      topK: z.number().int().min(1).max(8).optional().describe("How many snippets to retrieve (default 3)."),
    }),
    execute: async ({ query, topK }) => {
      const hits = await searchNotes(query, topK ?? 3);
      const sources: LeashSource[] = hits.map((h) => ({ kind: "graph", title: `Note · ${h.source}`, snippet: oneLine(h.text).slice(0, 200) }));
      return {
        text: hits.length ? hits.map((h) => `(${h.source}) ${oneLine(h.text)}`).join("\n---\n") : "No matching passages in the user's private notes.",
        sources,
      };
    },
  }),

  understory_search: tool({
    description:
      "Search The Understory — the user's auto-written, on-device daily paper — for PUBLISHED articles relevant to a query. Use for questions about what the paper has covered.",
    inputSchema: z.object({
      query: z.string().describe("What to look for across headlines, deks, and bodies."),
      topK: z.number().int().min(1).max(12).optional().describe("How many articles (default 5)."),
    }),
    execute: async ({ query, topK }) => {
      const q = query.trim();
      if (q.length < 2) return { text: "Provide a search query of at least 2 characters.", sources: [] as LeashSource[] };
      const rows = await prisma.article.findMany({
        where: { stage: Stage.PUBLISHED, OR: [{ headline: { contains: q } }, { dek: { contains: q } }, { body: { contains: q } }] },
        orderBy: [{ publishedAt: "desc" }],
        take: topK ?? 5,
        select: { date: true, slug: true, headline: true, dek: true },
      });
      const sources: LeashSource[] = rows.map((r) => ({ kind: "paper", title: r.headline, snippet: oneLine(r.dek), url: `/${r.date}/${r.slug}` }));
      return {
        text: rows.length ? rows.map((r) => `(${r.date}) ${r.headline} — ${oneLine(r.dek)}`).join("\n") : `No published articles match "${q}".`,
        sources,
      };
    },
  }),

  understory_today: tool({
    description: "List the headlines published in the LATEST edition of The Understory. Use when asked what's in today's paper / today's news.",
    inputSchema: z.object({}),
    execute: async () => {
      const latest = await prisma.article.findFirst({ where: { stage: Stage.PUBLISHED }, orderBy: [{ date: "desc" }], select: { date: true } });
      if (!latest) return { text: "The Understory has no published editions yet.", sources: [] as LeashSource[] };
      const rows = await prisma.article.findMany({
        where: { stage: Stage.PUBLISHED, date: latest.date },
        orderBy: [{ publishedAt: "asc" }],
        select: { date: true, slug: true, headline: true, dek: true },
      });
      const sources: LeashSource[] = rows.map((r) => ({ kind: "paper", title: r.headline, snippet: oneLine(r.dek), url: `/${r.date}/${r.slug}` }));
      return {
        text: `The Understory — latest edition (${latest.date}), ${rows.length} stories:\n` + rows.map((r) => `${r.headline} — ${oneLine(r.dek)}`).join("\n"),
        sources,
      };
    },
  }),

  now: tool({
    description: "Get the current local date and time. Use when the answer depends on what day or time it is.",
    inputSchema: z.object({}),
    execute: async () => ({ text: `Current local date/time: ${new Date().toString()}`, sources: [] as LeashSource[] }),
  }),

  list_photos: tool({
    description:
      "List the user's images and their on-device auto-tags (e.g. document, food, other). Use to answer what photos/images the user has, or to find images of a kind. Tags are produced by on-device classification (`npm run tag-photos`).",
    inputSchema: z.object({
      label: z.string().optional().describe("Optional: only images whose top tag matches this label (e.g. 'food', 'report', 'other')."),
    }),
    execute: async ({ label }) => {
      let tags: PhotoTag[] = [];
      try {
        tags = JSON.parse(await readFile(PHOTO_TAGS, "utf-8")) as PhotoTag[];
      } catch {
        return { text: "No images have been tagged yet. Run `npm run tag-photos` to classify images in data/photos.", sources: [] as LeashSource[] };
      }
      const want = label?.trim().toLowerCase();
      const filtered = want ? tags.filter((t) => t.label.toLowerCase() === want) : tags;
      if (filtered.length === 0) {
        return { text: want ? `No images tagged "${label}".` : "No tagged images found.", sources: [] as LeashSource[] };
      }
      const sources: LeashSource[] = filtered.map((t) => ({ kind: "graph", title: `Image · ${t.file}`, snippet: `${t.label} (${Math.round(t.confidence * 100)}%)${t.isDocument ? " · document" : ""}` }));
      return {
        text: filtered.map((t) => `${t.file} — ${t.label} (${Math.round(t.confidence * 100)}%)${t.isDocument ? ", document" : ""}`).join("\n"),
        sources,
      };
    },
  }),

  generate_image: tool({
    description:
      "Generate an image from a text description, fully on-device. Use when the user asks to draw, create, generate, paint, or visualize a picture/image. Write a vivid, detailed prompt.",
    inputSchema: z.object({
      prompt: z.string().describe("A detailed visual description of the image to generate."),
    }),
    execute: async ({ prompt }) => {
      const { image } = await generateImage({ model: imageModel(), prompt, size: "512x512" });
      await mkdir(GEN_DIR, { recursive: true });
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      await writeFile(join(GEN_DIR, name), Buffer.from(image.uint8Array));
      // Return a small URL (not base64) so the message stream stays light; UI renders the file.
      return { url: `/leash-gen/${name}`, prompt, text: `Generated an image for: ${prompt}` };
    },
  }),
};

/** The assistant's system prompt — tool-first grounding. */
export const LEASH_SYSTEM =
  "You are Leash, a private, on-device assistant with access to the user's world. You have tools: " +
  "search_graph (their private notes/files/voice memos), understory_search and understory_today " +
  "(The Understory — their auto-written daily paper), and now (current date/time). " +
  "For anything about the user, their notes, or their paper, CALL THE RELEVANT TOOL FIRST instead of guessing. " +
  "After tool results, answer concisely and factually. If the tools don't contain the answer, say so plainly.";
