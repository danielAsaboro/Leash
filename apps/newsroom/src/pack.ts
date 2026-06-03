/**
 * The research pack — an article's grounding sources.
 *
 * One canonical, numbered list of sources (each with its text) is the spine that
 * keeps everything aligned: the SOURCES sidebar rows, the `[Source N]` citations the
 * drafter writes, and the snippets the reviewer/verifier checks against all refer to
 * the SAME numbered list. The pack is persisted on the article's `Dossier.research`
 * (JSON) and its texts are embedded into the article's private RAG workspace, so the
 * draft step can retrieve over it (real on-device RAG) while citations stay coherent.
 */
import type { Hit } from "@mycelium/senses";
import { ingestNodes } from "@mycelium/senses";
import type { GraphNode } from "@mycelium/shared";
import { prisma } from "@mycelium/db";
import { workspaceFor } from "./config.ts";
import type { Newsroom } from "./context.ts";

export interface PackSource {
  label: string;
  url?: string;
  kind: string; // rss | web | note | voice | photo | graph
  text: string;
}

export interface ResearchPack {
  topic: string;
  sources: PackSource[];
}

/** Render the pack as numbered `[Source N]` context for a model prompt. */
export function numbered(pack: ResearchPack): string {
  return pack.sources
    .map((s, i) => `[Source ${i + 1}] (${s.kind}${s.url ? ` ${s.url}` : ""}) ${s.text}`)
    .join("\n\n");
}

/** The pack's sources as `Hit`s, so the verifier checks the exact cited snippets. */
export function packHits(pack: ResearchPack): Hit[] {
  return pack.sources.map((s) => ({ content: s.text, score: 1 }));
}

/** Persist a pack: write the Dossier, embed its texts into the article's workspace. */
export async function persistPack(nr: Newsroom, articleId: string, pack: ResearchPack): Promise<number> {
  const nodes: GraphNode[] = pack.sources.map((s, i) => ({
    id: `${articleId}:${i}`,
    kind: "note",
    source: s.label,
    text: s.text,
    ts: new Date().toISOString(),
  }));
  const chunks = await ingestNodes({ embModelId: nr.embId, workspace: workspaceFor(articleId), nodes, audit: nr.audit });
  const graphNodeIds = nodes.map((n) => n.id);
  const research = JSON.stringify(pack);
  await prisma.dossier.upsert({
    where: { articleId },
    create: { articleId, research, graphNodeIds: JSON.stringify(graphNodeIds), tokens: chunks },
    update: { research, graphNodeIds: JSON.stringify(graphNodeIds), tokens: chunks },
  });
  return chunks;
}

/** Read the pack back from an article's Dossier (throws if missing). */
export async function readPack(articleId: string): Promise<ResearchPack> {
  const dossier = await prisma.dossier.findUnique({ where: { articleId } });
  if (!dossier) throw new Error(`no dossier for article ${articleId}`);
  return JSON.parse(dossier.research) as ResearchPack;
}
