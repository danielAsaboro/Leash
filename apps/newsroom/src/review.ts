/**
 * Review: the newsroom critic. Extends the council's `verifyClaims` (one pass/revise
 * verdict, kept for the audit trail) into a LIST of checkable claims — each labelled
 * VERIFIED / UNVERIFIED / CONFLICTED against the same numbered sources, with a note.
 * This list is exactly the UNVERIFIED CLAIMS sidebar in the reader.
 */
import { verifyClaims } from "@mycelium/mind";
import { prisma, Stage, ClaimStatus, type ClaimStatus as ClaimStatusT } from "@mycelium/db";
import { readPack, packHits } from "./pack.ts";
import { complete, extractJson } from "./context.ts";
import { tidy } from "./util.ts";
import type { Newsroom } from "./context.ts";
import { NEWSROOM_CRITIC_SYSTEM } from "./prompt.ts";

interface ClaimJson {
  text: string;
  status: string;
  note?: string;
}

function normStatus(s: string | undefined): ClaimStatusT {
  const up = (s ?? "").toUpperCase();
  if (up === ClaimStatus.VERIFIED || up === ClaimStatus.CONFLICTED) return up;
  return ClaimStatus.UNVERIFIED;
}

export async function review(nr: Newsroom, articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  const pack = await readPack(articleId);
  const hits = packHits(pack);

  // Keep the council's overall verdict in the audit trail.
  await verifyClaims({ llmModelId: nr.llmId, answer: article.body, sources: hits, audit: nr.audit });

  const sourceText = pack.sources.map((s, i) => `[Source ${i + 1}] ${s.text}`).join("\n");
  const user = `ARTICLE:\n${article.headline}\n${article.body}\n\nSOURCES:\n${sourceText}`;
  const raw = await complete(nr, NEWSROOM_CRITIC_SYSTEM, user, 500, "critic");

  const parsed = extractJson<ClaimJson[]>(raw) ?? [];
  const claims = parsed
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .slice(0, 4)
    .map((c, i) => ({
      text: tidy(c.text, 300),
      status: normStatus(c.status),
      note: tidy(c.note || "Needs fact-checking or primary confirmation", 200),
      order: i,
    }));

  // Replace any prior claims (idempotent re-review).
  await prisma.claim.deleteMany({ where: { articleId } });
  if (claims.length > 0) {
    await prisma.claim.createMany({ data: claims.map((c) => ({ ...c, articleId })) });
  }
  await prisma.article.update({ where: { id: articleId }, data: { stage: Stage.REVIEW } });
}
