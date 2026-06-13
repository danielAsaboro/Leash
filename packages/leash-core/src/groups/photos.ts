/**
 * Photos tool group — list the user's images and their on-device auto-tags
 * (`data/leash-photo-tags.json`, produced by `npm run tag-photos`). Read-only.
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { PHOTO_TAGS } from "../paths.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

interface PhotoTag {
  file: string;
  label: string;
  confidence: number;
  isDocument: boolean;
}

export const photosGroup: ToolGroup = {
  id: "photos",
  label: "Photos",
  description: "List the user's images and their on-device auto-tags (document, food, other).",
  tools: [
    defineTool({
      name: "list_photos",
      description:
        "List the user's images and their on-device auto-tags (e.g. document, food, other). Use to answer what photos/images the user has, or to find images of a kind. Tags are produced by on-device classification (`npm run tag-photos`).",
      inputSchema: {
        label: z.string().optional().describe("Optional: only images whose top tag matches this label (e.g. 'food', 'report', 'other')."),
      },
      handler: async ({ label }) => {
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
        const sources: LeashSource[] = filtered.map((t) => ({
          kind: "graph",
          title: `Image · ${t.file}`,
          snippet: `${t.label} (${Math.round(t.confidence * 100)}%)${t.isDocument ? " · document" : ""}`,
        }));
        return {
          text: filtered.map((t) => `${t.file} — ${t.label} (${Math.round(t.confidence * 100)}%)${t.isDocument ? ", document" : ""}`).join("\n"),
          sources,
        };
      },
    }),
  ],
};
