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
import { scoreIntentPrototype, selectIntentCandidate } from "@mycelium/leash-core/intent-prototype";
import { RecoverablePromiseCache } from "@mycelium/leash-core/recoverable-promise-cache";
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
// Skill-activation floors. We load the single best-matching skill whose score clears a floor —
// keyword (lexical) OR semantic (embedding). A candidate must clear a floor so general turns load
// NO skill; among the survivors, calibrated prototype evidence orders and the #1 is taken (no margin gate — it dropped
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
   * makes a step-skill a reliable multi-step workflow on chat (the 4B can't drop a chain it
   * doesn't own; verified 2026-06-12: pipeline 3/3 vs free-run ~1/3 on a dependent chain). Null
   * when no active skill declares steps (normal free-run turn).
   */
  pipeline: { slug: string; steps: string[] } | null;
}

interface SkillUtteranceEmbeddings {
  slug: string;
  /** One embedding per utterance (discovery text + `when_to_use` + metadata examples). */
  utterances: string[];
  embeddings: number[][];
}

const skillEmbeddingCache = new RecoverablePromiseCache<SkillUtteranceEmbeddings[]>();

/** A skill's routing utterances: its discovery text PLUS each declared example (capped). The matcher
 *  routes by MAX similarity to any of these (semantic-router style), so several concrete phrasings can
 *  represent the skill — not just its one description. */
function skillUtterances(skill: { slug: string; name: string; description: string; examples?: string[]; whenToUse?: string }): string[] {
  // Routing utterances = discovery text + standard `when_to_use:` lines + Leash metadata examples.
  const whenLines = skill.whenToUse ? skill.whenToUse.split(/\r?\n/) : [];
  return [discoveryText(skill), ...whenLines, ...(skill.examples ?? [])].map((u) => u.trim()).filter(Boolean).slice(0, 12);
}

function mentionsSkill(haystack: string, slug: string, name: string): boolean {
  const slugRe = new RegExp(`(?:^|[^a-z0-9-])@?${escapeRe(slug)}(?:$|[^a-z0-9-])`, "i");
  const nameRe = new RegExp(`(?:^|[^a-z0-9])${escapeRe(name)}(?:$|[^a-z0-9])`, "i");
  return slugRe.test(haystack) || nameRe.test(haystack);
}

function discoveryText(skill: { slug: string; name: string; description: string }): string {
  return `${skill.slug}: ${skill.description || skill.name}`;
}

const DIRECT_TOOL_REQUEST_RE = /\b(?:tool only|use (?:the )?[a-z0-9_-]+ (?:mcp )?tool|do not use (?:run_skill|skills?|search_graph))\b/i;
const APPLE_NOTES_REQUEST_RE = /\b(?:apple notes|notes\.app|search-notes|get-note(?:s|-content|-details|-by-id|-markdown)?|create-note|update-note|delete-note|move-note|list-notes|doctor)\b/i;
const TASK_COMMITMENT_RE =
  /\b(?:add|create|make)\s+(?:a\s+)?(?:todo|to-do|task)\b|\bremind\s+me\s+to\b|\b(?:mark|set)\b[\s\S]{0,80}\b(?:todo|to-do|task)\b[\s\S]{0,40}\b(?:done|complete|in[- ]?progress)\b/i;

function skillEligibleForAutoActivation(query: string, skill: { slug: string }): boolean {
  if (DIRECT_TOOL_REQUEST_RE.test(query)) return false;
  if (skill.slug === "file-finder" && APPLE_NOTES_REQUEST_RE.test(query)) return false;
  if (skill.slug !== "mcp-installer") return true;
  return (
    /\b(?:install|add|set\s*up|setup|register|connect|configure|wire|enable)\b[\s\S]{0,80}\b(?:mcp|server|tool|integration)\b/i.test(query) ||
    /\b(?:mcp|server|tool|integration)\b[\s\S]{0,80}\b(?:install|add|set\s*up|setup|register|connect|configure|wire|enable)\b/i.test(query) ||
    /\b(?:github\.com|mcpservers\.org|npx\s+-?y|npm\s+(?:exec|install))\b/i.test(query)
  );
}

async function getSkillEmbeddings(skills: Array<{ slug: string; name: string; description: string; examples?: string[]; whenToUse?: string }>): Promise<SkillUtteranceEmbeddings[]> {
  const spans = skills.map((s) => ({ slug: s.slug, utterances: skillUtterances(s) }));
  const key = JSON.stringify(spans);
  return skillEmbeddingCache.get(key, async () => {
    // Embed ALL utterances of ALL skills in one batched call, then regroup by skill.
    const flat = spans.flatMap((s) => s.utterances);
    const { embeddings } = await embedMany({ model: embeddingModel(), values: flat });
    let i = 0;
    const rows = spans.map((s) => {
      const group = embeddings.slice(i, i + s.utterances.length) as number[][];
      i += s.utterances.length;
      return { slug: s.slug, utterances: s.utterances, embeddings: group };
    });
    return rows;
  });
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
  const enabled = (await listSkills()).filter((s) => s.enabled && !s.disableModelInvocation);
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

  // Stateful commitments have an exact lexical contract. Resolve these before
  // semantic ranking so a small conductor cannot turn "add a todo" into a
  // conversational acknowledgement that never reaches the task tool.
  if (TASK_COMMITMENT_RE.test(query)) {
    const taskManager = enabled.find(
      (skill) => skill.slug === "task-manager" && !skill.disableModelInvocation,
    );
    if (taskManager) return activeSkillsResult("automatic", [taskManager]);
  }

  // Auto-selection (intent prototypes). Each skill is represented by its discovery
  // text PLUS its declared `when_to_use:` utterances and metadata examples; the embedding score is the MAX cosine over those
  // utterances — so a skill that lists the exact intent it's for out-scores a broad sibling on that intent
  // (this is what lets the SPECIFIC skill win, the gap a single-description embedding couldn't close).
  // Lexical coverage and calibrated embedding evidence are fused per prototype before taking the best
  // prototype per skill. A confidence floor still gates candidates (so general turns load no skill). One
  // skill at a time keeps context lean — the model pulls in others mid-turn with read_skill.
  const routable = enabled.filter((s) => !s.disableModelInvocation && skillEligibleForAutoActivation(query, s));
  if (routable.length === 0) return null;
  const utterances = new Map(routable.map((skill) => [skill.slug, skillUtterances(skill)]));
  const lex = new Map<string, number>();
  const emb = new Map<string, number>();
  const routeScore = new Map<string, number>();
  try {
    const rows = await getSkillEmbeddings(routable);
    const { embedding } = await embed({ model: embeddingModel(), value: query });
    for (const row of rows) {
      let best = { lexical: 0, semantic: 0, score: 0 };
      let bestCosine = -1;
      for (let index = 0; index < row.utterances.length; index++) {
        const similarity = cosine(embedding, row.embeddings[index]!);
        const match = scoreIntentPrototype({ query, prototype: row.utterances[index]!, cosineSimilarity: similarity, semanticFloor: SKILL_EMB_FLOOR });
        if (match.score > best.score) best = match;
        if (similarity > bestCosine) bestCosine = similarity;
      }
      lex.set(row.slug, best.lexical);
      emb.set(row.slug, bestCosine);
      routeScore.set(row.slug, best.score);
    }
  } catch {
    for (const skill of routable) {
      const best = (utterances.get(skill.slug) ?? []).reduce(
        (current, prototype) => {
          const match = scoreIntentPrototype({ query, prototype, cosineSimilarity: -1, semanticFloor: SKILL_EMB_FLOOR });
          return match.score > current.score ? match : current;
        },
        { lexical: 0, semantic: 0, score: 0 },
      );
      lex.set(skill.slug, best.lexical);
      routeScore.set(skill.slug, best.score);
    }
  }
  const best = selectIntentCandidate({
    candidates: routable.map((skill) => ({
      value: skill,
      lexical: lex.get(skill.slug) ?? 0,
      semantic: 0,
      score: routeScore.get(skill.slug) ?? 0,
      cosine: emb.get(skill.slug) ?? -1,
      specialist: !skill.builtin,
    })),
    lexicalFloor: SKILL_LEX_FLOOR,
    semanticFloor: SKILL_EMB_FLOOR,
  })?.value;
  // Gated diagnostic: the top few candidates with their lex/emb so floors can be tuned against real queries.
  const top = [...routable].sort((a, b) => (routeScore.get(b.slug) ?? 0) - (routeScore.get(a.slug) ?? 0)).slice(0, 3);
  loopLog(`match "${query.slice(0, 40)}" → ${best?.slug ?? "(none)"} | top: ${top.map((s) => `${s.slug}(score=${(routeScore.get(s.slug) ?? 0).toFixed(2)},lex=${(lex.get(s.slug) ?? 0).toFixed(2)},emb=${(emb.get(s.slug) ?? -1).toFixed(2)})`).join(" ")}`);
  return best ? activeSkillsResult("automatic", [best]) : null;
}

/** Rehydrate one previously-selected enabled skill for a bounded multi-turn continuation. */
export async function activeSkillBySlug(slug: string): Promise<ActiveSkillsResult | null> {
  const skill = (await listSkills()).find((candidate) => candidate.enabled && !candidate.disableModelInvocation && candidate.slug === slug);
  return skill ? activeSkillsResult("automatic", [skill]) : null;
}
