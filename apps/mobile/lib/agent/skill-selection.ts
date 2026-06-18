/**
 * Skill SELECTION — the pure-TS core of `apps/web/lib/leash/skill-tools.ts`, ported for on-device.
 *
 * Given the enabled skills and the user's text, pick at most ONE skill: explicit name match wins;
 * otherwise lexical (keyword overlap) + embedding (max cosine over the skill's utterances) signals
 * are fused with Reciprocal Rank Fusion, gated by per-signal floors so general turns load nothing.
 * No I/O here — the skills list and an optional `embed()` are injected (the web reads them from disk
 * + an HTTP embeddings endpoint; the phone passes an in-memory list + the on-device embedder, and
 * falls back to lexical-only when embeddings aren't available).
 */
import { cosineSimilarity as cosine } from "ai";

export type SkillDef = {
  slug: string;
  name: string;
  description: string;
  body: string;
  examples?: string[];
  whenToUse?: string;
};

// Floors match the web defaults (gte-large compresses cosines into a high band → 0.81).
const SKILL_LEX_FLOOR = 0.45;
const SKILL_EMB_FLOOR = 0.81;
const K = 60; // RRF constant (community default).

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "get", "give", "help", "how", "i",
  "if", "in", "into", "is", "it", "let", "make", "me", "my", "of", "on", "or", "please", "show", "that", "this",
  "to", "use", "want", "with", "you",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter((t) => !STOP.has(t));
}

function lexicalScore(query: string, skill: SkillDef): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const target = new Set(tokenize(`${skill.slug} ${skill.name} ${skill.description} ${skill.whenToUse ?? ""} ${(skill.examples ?? []).join(" ")}`));
  if (target.size === 0) return 0;
  let hits = 0;
  for (const t of q) if (target.has(t)) hits++;
  const coverage = hits / q.size;
  const precision = hits / target.size;
  return coverage * 0.75 + precision * 0.25;
}

/** The utterances embedded per skill (name + description + whenToUse + examples). */
function utterances(s: SkillDef): string[] {
  return [s.name, s.description, s.whenToUse ?? "", ...(s.examples ?? [])].filter((u) => u.trim().length > 0);
}

export type SkillMatch = { skill: SkillDef; mode: "explicit" | "auto" };

/**
 * Select at most one skill for the turn. `embed` (optional) maps a string → vector; when omitted or
 * throwing, selection degrades to lexical-only (still floor-gated).
 */
export async function selectSkill(
  query: string,
  skills: SkillDef[],
  embed?: (texts: string[]) => Promise<number[][]>,
): Promise<SkillMatch | null> {
  const enabled = skills.filter((s) => s.slug && s.name);
  if (enabled.length === 0) return null;

  // Explicit: the user named a skill by slug or name.
  const ql = query.toLowerCase();
  const explicit = enabled.find((s) => ql.includes(s.slug.toLowerCase()) || ql.includes(s.name.toLowerCase()));
  if (explicit) return { skill: explicit, mode: "explicit" };

  const lex = new Map(enabled.map((s) => [s.slug, lexicalScore(query, s)]));
  const emb = new Map<string, number>();
  if (embed) {
    try {
      const queryVec = (await embed([query]))[0]!;
      // Embed each skill's utterances; score = max cosine to the query.
      for (const s of enabled) {
        const us = utterances(s);
        if (us.length === 0) continue;
        const vecs = await embed(us);
        emb.set(s.slug, vecs.reduce((m, v) => Math.max(m, cosine(queryVec, v)), -1));
      }
    } catch {
      /* fall back to lexical-only */
    }
  }

  const rankBy = (score: (slug: string) => number): Map<string, number> => {
    const order = [...enabled].sort((a, b) => score(b.slug) - score(a.slug));
    return new Map(order.map((s, i) => [s.slug, i + 1]));
  };
  const lexRank = rankBy((slug) => lex.get(slug) ?? 0);
  const embRank = rankBy((slug) => emb.get(slug) ?? -1);
  const rrf = (slug: string): number => 1 / (K + (lexRank.get(slug) ?? enabled.length)) + 1 / (K + (embRank.get(slug) ?? enabled.length));

  const best = enabled
    .filter((s) => (lex.get(s.slug) ?? 0) >= SKILL_LEX_FLOOR || (emb.get(s.slug) ?? -1) >= SKILL_EMB_FLOOR)
    .sort((a, b) => rrf(b.slug) - rrf(a.slug))[0];

  return best ? { skill: best, mode: "auto" } : null;
}
