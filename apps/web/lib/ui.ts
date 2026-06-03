/**
 * Small presentation helpers shared across server AND client components. Kept free of
 * any `@mycelium/db` import on purpose: that package pulls in Prisma + `node:` built-ins,
 * which can't be bundled for the browser (the ⌘K palette is a client component). Stage
 * values are compared as the plain strings they are.
 */

/** The kicker shown above a headline. PERSONAL briefs read "Private Brief". */
export function sectionKicker(section: string, origin: string): string {
  if (origin === "PERSONAL") return "Private Brief";
  const map: Record<string, string> = { AI: "Artificial Intelligence", COMPUTE: "Compute", SOLANA: "Solana", BRIEF: "Brief" };
  return map[section] ?? section;
}

/** The pipeline track on Mission Control + the article status pill. */
export const STAGE_STEPS = ["RESEARCH", "DRAFT", "REVIEW", "PUBLISH"] as const;

/** Map a DB stage to the active step index (−1 = queued, 3 = published). */
export function stageIndex(stage: string): number {
  switch (stage) {
    case "QUEUED":
      return -1;
    case "RESEARCHING":
    case "RESEARCH_READY":
      return 0;
    case "DRAFTING":
      return 1;
    case "REVIEW":
      return 2;
    case "PUBLISHED":
      return 3;
    default:
      return -1;
  }
}

/** Human label for a status pill. */
export function stageLabel(stage: string): string {
  return stage.replace("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ───────────────────────── Bulletins ─────────────────────────
   A "bulletin" is a time-sensitive PERSONAL item — an important mail, a hackathon
   worth applying to, an invoice due. Today these are *derived on the read side* from
   the article's own fields (no schema change). When real ingestion + a daemon
   priority lane land later, they simply set a flag this UI already styles. */

const BULLETIN_RE = /\b(deadline|apply|applies|due|hackathon|rsvp|invoice|expires?|reminder|register|closing)\b/i;
const OPPORTUNITY_RE = /\b(hackathon|apply|applies|grant|opportunity|register|bounty|invite)\b/i;

/** True for a time-sensitive personal item worth surfacing in the JUST IN band. */
export function isBulletin(a: { origin: string; headline: string; dek?: string | null }): boolean {
  if (a.origin !== "PERSONAL") return false;
  return BULLETIN_RE.test(a.headline) || BULLETIN_RE.test(a.dek ?? "");
}

/** The kicker a bulletin carries in the mosaic / band. */
export function bulletinKicker(a: { headline: string; dek?: string | null }): "OPPORTUNITY" | "BULLETIN" {
  return OPPORTUNITY_RE.test(a.headline) || OPPORTUNITY_RE.test(a.dek ?? "") ? "OPPORTUNITY" : "BULLETIN";
}
