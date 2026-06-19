/**
 * The skills ↔ chat bridge (server-only): a system-prompt section listing enabled
 * skills (name + description only — bodies stay on disk), `read_skill` to load a
 * skill's SKILL.md on demand, `read_skill_file` for its attachments, and
 * `run_skill_script` for its bundled `scripts/*` (real execution — approval-gated by
 * default, see skill-exec.ts). Mirrors how Claude-style skills keep the prompt small
 * until a skill is actually relevant.
 */
import "server-only";
import { embed, embedMany } from "ai";
import { listSkills } from "./skills-store.ts";
import { loopLog } from "./loop-diagnostics.ts";
import { embeddingModel } from "./provider.ts";
import { cosine } from "./graph.ts";
import {
  ACTIVE_SKILL_TOOL_CALL_WARNING,
  buildActiveSkillBody,
  buildActiveSkillHeader,
  buildSkillsCatalogPrompt,
} from "./prompt.ts";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "get",
  "give",
  "help",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "let",
  "make",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "show",
  "that",
  "the",
  "this",
  "to",
  "use",
  "want",
  "with",
  "you",
]);
// Skill-activation floors. We load the single best-matching skill whose score clears a floor —
// keyword (lexical) OR semantic (embedding). A candidate must clear a floor so general turns load
// NO skill; among the survivors, RRF orders and the #1 is taken (no margin gate — it dropped
// correct-but-clustered skills, measured). Floors CALIBRATED 2026-06-12 against real queries with
// the multi-utterance matcher + gte-large: that encoder compresses cosines into a HIGH band, so
// general prompts ("tell me a joke") land at emb~0.78-0.80 while true intents land at 0.82-0.99 —
// the old 0.74 floor sat inside the false-positive zone. 0.81 separates them (TP-min 0.82 vs
// FP-max 0.80). Lexical floor 0.45 gives a keyword-only second path (general prompts score ≤0.26).
// Both overridable via env.
const SKILL_LEX_FLOOR = Number(process.env["LEASH_SKILL_LEX_FLOOR"] ?? 0.45);
const SKILL_EMB_FLOOR = Number(process.env["LEASH_SKILL_EMB_FLOOR"] ?? 0.81);

interface ActiveSkillView {
  slug: string;
  name: string;
  body: string;
  tools: string[];
  steps: string[];
  files: string[];
}

export interface ActiveSkillsResult {
  mode: "explicit" | "automatic";
  section: string;
  skills: Array<{ slug: string; name: string }>;
  /**
   * Union of the active skill(s)' declared `tools:` (frontmatter). When non-empty the chat
   * route passes this to the agent as `skillTools`, which OVERRIDES the route's default
   * toolset with exactly these names (progressive tool disclosure — see agent.ts).
   */
  tools: string[];
  /**
   * Set when the (first) active skill declares an ordered `steps:` plan. The chat route then runs
   * that skill as a DETERMINISTIC PIPELINE (skill-runner.ts) for this turn — the harness drives the
   * steps, the model does one atomic sub-task each — INSTEAD of a free-run agent turn. This is what
   * makes a step-skill a reliable multi-step workflow on qwen3-4b (the 4B can't drop a chain it
   * doesn't own; verified 2026-06-12: pipeline 3/3 vs free-run ~1/3 on a dependent chain). Null
   * when no active skill declares steps (normal free-run turn).
   */
  pipeline: { slug: string; steps: string[] } | null;
}

interface SkillUtteranceEmbeddings {
  slug: string;
  /** One embedding per utterance (the discovery text + each declared `examples:` line). */
  embeddings: number[][];
}

interface SkillEmbeddingCache {
  key: string;
  rows: SkillUtteranceEmbeddings[];
}

let skillEmbeddingsPromise: Promise<SkillEmbeddingCache> | null = null;

/** A skill's routing utterances: its discovery text PLUS each declared example (capped). The matcher
 *  routes by MAX similarity to any of these (semantic-router style), so several concrete phrasings can
 *  represent the skill — not just its one description. */
function skillUtterances(skill: { slug: string; name: string; description: string; examples?: string[]; whenToUse?: string }): string[] {
  // Routing utterances = discovery text + the standard `when_to_use:` lines + any legacy `examples:`.
  const whenLines = skill.whenToUse ? skill.whenToUse.split(/\r?\n/) : [];
  return [discoveryText(skill), ...whenLines, ...(skill.examples ?? [])].map((u) => u.trim()).filter(Boolean).slice(0, 8);
}

function mentionsSkill(haystack: string, slug: string, name: string): boolean {
  const slugRe = new RegExp(`(?:^|[^a-z0-9-])@?${escapeRe(slug)}(?:$|[^a-z0-9-])`, "i");
  const nameRe = new RegExp(`(?:^|[^a-z0-9])${escapeRe(name)}(?:$|[^a-z0-9])`, "i");
  return slugRe.test(haystack) || nameRe.test(haystack);
}

function discoveryText(skill: { slug: string; name: string; description: string }): string {
  return `${skill.slug}: ${skill.description || skill.name}`;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter((t) => !STOP.has(t));
}

function lexicalScore(query: string, skill: { slug: string; name: string; description: string; examples?: string[]; whenToUse?: string }): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  // when_to_use + examples are routing utterances — fold them into the lexical target so a skill's
  // concrete phrasings (e.g. "mark it done") count toward keyword overlap, not just its description.
  const target = new Set(tokenize(`${skill.slug} ${skill.name} ${skill.description} ${skill.whenToUse ?? ""} ${(skill.examples ?? []).join(" ")}`));
  if (target.size === 0) return 0;
  let hits = 0;
  for (const t of q) if (target.has(t)) hits++;
  const coverage = hits / q.size;
  const precision = hits / target.size;
  return coverage * 0.75 + precision * 0.25;
}

async function getSkillEmbeddings(skills: Array<{ slug: string; name: string; description: string; examples?: string[]; whenToUse?: string }>): Promise<SkillUtteranceEmbeddings[]> {
  const spans = skills.map((s) => ({ slug: s.slug, utterances: skillUtterances(s) }));
  const key = JSON.stringify(spans);
  if (skillEmbeddingsPromise) {
    const cached = await skillEmbeddingsPromise;
    if (cached.key === key) return cached.rows;
  }
  skillEmbeddingsPromise = (async () => {
    // Embed ALL utterances of ALL skills in one batched call, then regroup by skill.
    const flat = spans.flatMap((s) => s.utterances);
    const { embeddings } = await embedMany({ model: embeddingModel(), values: flat });
    let i = 0;
    const rows = spans.map((s) => {
      const group = embeddings.slice(i, i + s.utterances.length) as number[][];
      i += s.utterances.length;
      return { slug: s.slug, embeddings: group };
    });
    return { key, rows };
  })();
  return (await skillEmbeddingsPromise).rows;
}

function activeSkillsResult(reason: "explicit" | "automatic", skills: ActiveSkillView[]): ActiveSkillsResult {
  const stepSkill = skills.find((s) => (s.steps ?? []).length > 0);
  return {
    mode: reason,
    skills: skills.map((s) => ({ slug: s.slug, name: s.name })),
    tools: [...new Set(skills.flatMap((s) => s.tools ?? []))],
    pipeline: stepSkill ? { slug: stepSkill.slug, steps: stepSkill.steps } : null,
    section:
      buildActiveSkillHeader(reason, skills.map((s) => s.slug)) +
      ACTIVE_SKILL_TOOL_CALL_WARNING +
      "\n\n" +
      buildActiveSkillBody(skills),
  };
}

/**
 * System-prompt section advertising enabled skills. EMPTY STRING when there are none —
 * an honest empty state, no boilerplate about a feature that has nothing in it.
 */
export async function skillsSystemSection(): Promise<string> {
  const enabled = (await listSkills()).filter((s) => s.enabled);
  return buildSkillsCatalogPrompt(enabled);
}

/**
 * Deterministic skill activation for EXPLICIT mentions. Small models kept narrating
 * `read_skill(...)` in plain text instead of actually calling it, so if the user names
 * a skill directly (slug / @slug / exact skill name) we load that skill's body into the
 * system prompt for this turn. Generic matches still rely on the normal read_skill tool.
 */
export async function activeSkillsSection(userText: string): Promise<ActiveSkillsResult | null> {
  const query = userText.trim().toLowerCase();
  if (!query) return null;
  const enabled = (await listSkills()).filter((s) => s.enabled);
  const explicit = enabled.filter((s) => mentionsSkill(query, s.slug.toLowerCase(), s.name.trim().toLowerCase()));
  if (explicit.length > 0) {
    return activeSkillsResult("explicit", explicit);
  }

  // Auto-selection (semantic-router + Reciprocal Rank Fusion). Each skill is represented by its discovery
  // text PLUS its declared `examples:` utterances; the embedding score is the MAX cosine over those
  // utterances — so a skill that lists the exact intent it's for out-scores a broad sibling on that intent
  // (this is what lets the SPECIFIC skill win, the gap a single-description embedding couldn't close).
  // Lexical and embedding rankings are then fused with RRF (rank-based, scale-free, rewards agreement
  // across BOTH signals) instead of comparing two differently-scaled scores via max(). A confidence FLOOR
  // still gates candidates (so general turns load no skill); RRF only ORDERS the ones that clear it. One
  // skill at a time keeps context lean — the model pulls in others mid-turn with read_skill.
  const lex = new Map(enabled.map((s) => [s.slug, lexicalScore(query, s)]));
  const emb = new Map<string, number>();
  try {
    const rows = await getSkillEmbeddings(enabled);
    const { embedding } = await embed({ model: embeddingModel(), value: query });
    for (const r of rows) emb.set(r.slug, r.embeddings.reduce((m, e) => Math.max(m, cosine(embedding, e)), -1));
  } catch {
    /* embeddings serve unavailable — fall back to lexical-only activation */
  }
  // Rank each signal (1-based, descending) → RRF score = Σ 1/(k + rank), k=60 (community default).
  const rankBy = (score: (slug: string) => number): Map<string, number> => {
    const order = [...enabled].sort((a, b) => score(b.slug) - score(a.slug));
    return new Map(order.map((s, i) => [s.slug, i + 1]));
  };
  const lexRank = rankBy((slug) => lex.get(slug) ?? 0);
  const embRank = rankBy((slug) => emb.get(slug) ?? -1);
  const K = 60;
  const rrf = (slug: string): number => 1 / (K + (lexRank.get(slug) ?? enabled.length)) + 1 / (K + (embRank.get(slug) ?? enabled.length));
  const best = enabled
    .filter((s) => (lex.get(s.slug) ?? 0) >= SKILL_LEX_FLOOR || (emb.get(s.slug) ?? -1) >= SKILL_EMB_FLOOR)
    .sort((a, b) => rrf(b.slug) - rrf(a.slug))[0];
  // Gated diagnostic: the top few candidates with their lex/emb so floors can be tuned against real queries.
  const top = [...enabled].sort((a, b) => Math.max(emb.get(b.slug) ?? -1, lex.get(b.slug) ?? 0) - Math.max(emb.get(a.slug) ?? -1, lex.get(a.slug) ?? 0)).slice(0, 3);
  loopLog(`match "${query.slice(0, 40)}" → ${best?.slug ?? "(none)"} | top: ${top.map((s) => `${s.slug}(lex=${(lex.get(s.slug) ?? 0).toFixed(2)},emb=${(emb.get(s.slug) ?? -1).toFixed(2)})`).join(" ")}`);
  return best ? activeSkillsResult("automatic", [best]) : null;
}
