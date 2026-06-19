/**
 * Draft: the on-device journalist. Grounds over the article's private RAG workspace
 * (real `searchGraph` retrieval — recorded as a `rag_search` in the audit trail),
 * then asks the council LLM to write a tight, `[Source N]`-cited story from ONLY the
 * numbered pack sources. The `[Source N]` indices line up 1:1 with the SOURCES
 * sidebar rows because both are the pack's ordered sources.
 */
import { searchGraph } from "@mycelium/senses";
import { prisma, Stage, Origin } from "@mycelium/db";
import { workspaceFor } from "./config.ts";
import { numbered, readPack } from "./pack.ts";
import { complete, extractJson } from "./context.ts";
import { tidy } from "./util.ts";
import type { Newsroom } from "./context.ts";
import { NEWS_DRAFT_SYSTEM, PERSONAL_BRIEF_DRAFT_SYSTEM } from "./prompt.ts";

interface DraftJson {
  headline: string;
  dek: string;
  body: string;
}

export async function draft(nr: Newsroom, articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  await prisma.article.update({ where: { id: articleId }, data: { stage: Stage.DRAFTING } });

  const pack = await readPack(articleId);
  // Real on-device retrieval over the article's own workspace (telemetry + grounding check).
  const hits = await searchGraph({ embModelId: nr.embId, workspace: workspaceFor(articleId), query: pack.topic, topK: Math.min(pack.sources.length || 1, 6), audit: nr.audit });
  const focus = hits[0]?.content ? `\n\nMOST RELEVANT: ${tidy(hits[0].content, 300)}` : "";

  const system = article.origin === Origin.PERSONAL ? PERSONAL_BRIEF_DRAFT_SYSTEM : NEWS_DRAFT_SYSTEM;
  const user = `TOPIC: ${pack.topic}\nSECTION: ${article.section}\n\nSOURCES:\n${numbered(pack)}${focus}`;
  const raw = await complete(nr, system, user, 900, "drafter");

  const parsed = extractJson<DraftJson>(raw);
  const headline = tidy(parsed?.headline || article.headline, 160);
  const dek = tidy(parsed?.dek || article.dek, 240);
  // Fall back to the raw text as the body if JSON parsing failed but we got prose.
  const body = (parsed?.body || raw).trim();

  await prisma.article.update({
    where: { id: articleId },
    data: { headline, dek, body, stage: Stage.REVIEW },
  });
}
