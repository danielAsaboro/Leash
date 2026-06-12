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
import { tool } from "ai";
import { z } from "zod";
import { listSkills, getSkill, readSkillFile } from "./skills-store.ts";
import { runSkillScript } from "./skill-exec.ts";
import { embeddingModel } from "./provider.ts";
import { cosine } from "./graph.ts";
import type { LeashSource } from "./tools.ts";

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
// keyword (lexical) OR semantic (embedding). The #1 match is taken directly (no margin gate: a
// margin gate dropped correct-but-clustered skills — measured), but it must clear the floor so
// general turns load no skill. Floors separate capability queries (~0.76+) from general ones
// (~0.72) and are overridable via env. The model composes by loading further skills with
// read_skill mid-turn, so one auto-loaded skill keeps the context lean without losing reach.
const SKILL_LEX_FLOOR = Number(process.env["LEASH_SKILL_LEX_FLOOR"] ?? 0.55);
const SKILL_EMB_FLOOR = Number(process.env["LEASH_SKILL_EMB_FLOOR"] ?? 0.74);

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

interface SkillEmbedding {
  slug: string;
  embedding: number[];
}

interface SkillEmbeddingCache {
  key: string;
  rows: SkillEmbedding[];
}

let skillEmbeddingsPromise: Promise<SkillEmbeddingCache> | null = null;

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

function lexicalScore(query: string, skill: { slug: string; name: string; description: string }): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const target = new Set(tokenize(`${skill.slug} ${skill.name} ${skill.description}`));
  if (target.size === 0) return 0;
  let hits = 0;
  for (const t of q) if (target.has(t)) hits++;
  const coverage = hits / q.size;
  const precision = hits / target.size;
  return coverage * 0.75 + precision * 0.25;
}

async function getSkillEmbeddings(skills: Array<{ slug: string; name: string; description: string }>): Promise<SkillEmbedding[]> {
  const key = JSON.stringify(skills.map((s) => [s.slug, s.name, s.description]));
  if (skillEmbeddingsPromise) {
    const cached = await skillEmbeddingsPromise;
    if (cached.key === key) return cached.rows;
  }
  skillEmbeddingsPromise = (async () => {
    const values = skills.map(discoveryText);
    const { embeddings } = await embedMany({ model: embeddingModel(), values });
    return {
      key,
      rows: skills.map((s, i) => ({ slug: s.slug, embedding: embeddings[i] as number[] })),
    };
  })();
  return (await skillEmbeddingsPromise).rows;
}

function renderActiveSkillHeader(reason: "explicit" | "automatic", matched: string[]): string {
  return reason === "explicit"
    ? "The user EXPLICITLY named the following skill(s). Their instructions are already loaded for this turn, so follow them directly."
    : `The route AUTO-MATCHED this request to the following skill(s) from their discovery descriptions: ${matched.join(", ")}. Their instructions are already loaded for this turn, so follow them directly.`;
}

function renderActiveSkillBody(skills: Array<{ slug: string; body: string; files: string[] }>): string {
  const sections = skills.map((s) => {
    const scripts = s.files.filter((f) => f.startsWith("scripts/"));
    const docs = s.files.filter((f) => !f.startsWith("scripts/"));
    const attachments =
      (docs.length ? `\nAttached files: ${docs.join(", ")} — read one with read_skill_file when referenced.` : "") +
      (scripts.length ? `\nExecutable scripts: ${scripts.join(", ")} — run one with run_skill_script when instructed.` : "");
    return `Skill "${s.slug}" is ACTIVE for this turn.\n\n${s.body || "(this skill has an empty body)"}${attachments}`;
  });
  return sections.join("\n\n---\n\n");
}

function activeSkillsResult(reason: "explicit" | "automatic", skills: ActiveSkillView[]): ActiveSkillsResult {
  const stepSkill = skills.find((s) => (s.steps ?? []).length > 0);
  return {
    mode: reason,
    skills: skills.map((s) => ({ slug: s.slug, name: s.name })),
    tools: [...new Set(skills.flatMap((s) => s.tools ?? []))],
    pipeline: stepSkill ? { slug: stepSkill.slug, steps: stepSkill.steps } : null,
    section:
      renderActiveSkillHeader(reason, skills.map((s) => s.slug)) +
      " Do not print fake tool-call text like `CALL read_skill(...)` in your answer. If a skill requires exact output, treat that as higher priority than your normal style and emit it with no extra words or surrounding whitespace.\n\n" +
      renderActiveSkillBody(skills),
  };
}

/**
 * System-prompt section advertising enabled skills. EMPTY STRING when there are none —
 * an honest empty state, no boilerplate about a feature that has nothing in it.
 */
export async function skillsSystemSection(): Promise<string> {
  const enabled = (await listSkills()).filter((s) => s.enabled);
  if (enabled.length === 0) return "";
  const lines = enabled.map((s) => `- "${s.slug}": ${s.description || s.name}`);
  return (
    "Your skills — when a request matches one of these, call read_skill with its slug to load its full instructions, then follow them to the letter. Actually call read_skill; don't just talk about it. Skills:\n" +
    lines.join("\n")
  );
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

  // Auto-selection: load the SINGLE best-matching skill whose score clears a confidence floor —
  // by keyword overlap (lexical) OR semantic similarity (embedding) against its discovery
  // metadata. One skill at a time keeps the context lean; the model can pull in OTHER skills
  // mid-turn with read_skill (the skill-system tools stay available inside an active skill —
  // see agent.ts). No margin gate: the #1 match is taken directly (margin gates dropped correct
  // but clustered skills — measured), but only if it clears the floor (so general turns load none).
  const lex = new Map(enabled.map((s) => [s.slug, lexicalScore(query, s)]));
  const emb = new Map<string, number>();
  try {
    const rows = await getSkillEmbeddings(enabled);
    const { embedding } = await embed({ model: embeddingModel(), value: query });
    for (const r of rows) emb.set(r.slug, cosine(embedding, r.embedding));
  } catch {
    /* embeddings serve unavailable — fall back to lexical-only activation */
  }
  const best = enabled
    .map((s) => ({ skill: s, lex: lex.get(s.slug) ?? 0, emb: emb.get(s.slug) ?? -1 }))
    .filter((c) => c.lex >= SKILL_LEX_FLOOR || c.emb >= SKILL_EMB_FLOOR)
    .sort((a, b) => Math.max(b.emb, b.lex) - Math.max(a.emb, a.lex))[0];
  return best ? activeSkillsResult("automatic", [best.skill]) : null;
}

export const skillTools = {
  read_skill: tool({
    description:
      "Read the full instructions of one of your skills (the user-authored instruction documents listed in your system prompt). Call this BEFORE acting whenever a request matches a skill's description, then follow the instructions.",
    inputSchema: z.object({
      skill: z.string().describe("The skill's slug, exactly as listed in the system prompt (e.g. 'trip-planning')."),
    }),
    execute: async ({ skill }) => {
      const s = await getSkill(skill.trim().toLowerCase());
      if (!s) {
        const known = (await listSkills()).filter((x) => x.enabled).map((x) => x.slug);
        return {
          text: `No skill named "${skill}".` + (known.length ? ` Available: ${known.join(", ")}.` : " No skills are defined yet."),
          sources: [] as LeashSource[],
        };
      }
      if (!s.enabled) return { text: `The skill "${s.slug}" is currently disabled.`, sources: [] as LeashSource[] };
      const scripts = s.files.filter((f) => f.startsWith("scripts/"));
      const docs = s.files.filter((f) => !f.startsWith("scripts/"));
      const attachments =
        (docs.length ? `\n\nThis skill has attached files: ${docs.join(", ")} — load one with read_skill_file when the instructions reference it.` : "") +
        (scripts.length ? `\n\nThis skill has executable scripts: ${scripts.join(", ")} — run one with run_skill_script when the instructions say to.` : "");
      return {
        // The closing line keeps small models from "calling" the skill as a tool next
        // step instead of just answering (observed on qwen3-4b).
        text: `Skill "${s.name}" instructions:\n\n${s.body || "(this skill has an empty body)"}${attachments}\n\nNow follow these instructions directly in your own answer — a skill is not a callable tool.`,
        sources: [{ kind: "graph", title: `Skill · ${s.name}`, snippet: s.description.slice(0, 200) }] as LeashSource[],
      };
    },
  }),

  read_skill_file: tool({
    description:
      "Read one of a skill's attached files (reference tables, templates, examples). Use AFTER read_skill, when its instructions point you to an attachment by name.",
    inputSchema: z.object({
      skill: z.string().describe("The skill's slug (e.g. 'trip-planning')."),
      file: z.string().describe("The attachment's filename exactly as listed by read_skill (e.g. 'airlines.md')."),
    }),
    execute: async ({ skill, file }) => {
      const r = await readSkillFile(skill.trim().toLowerCase(), file.trim());
      if (!r.ok) return { text: r.error, sources: [] as LeashSource[] };
      return {
        text: `Contents of ${skill}/${file}:\n\n${r.text}`,
        sources: [{ kind: "graph", title: `Skill file · ${skill}/${file}`, snippet: r.text.slice(0, 200) }] as LeashSource[],
      };
    },
  }),

  run_skill_script: tool({
    description:
      "Run one of a skill's bundled scripts (the executable files under its scripts/ folder, listed by read_skill). Use AFTER read_skill, when its instructions say to run a script. The script executes on this machine and its output comes back to you.",
    inputSchema: z.object({
      skill: z.string().describe("The skill's slug (e.g. 'trip-planning')."),
      script: z.string().describe("The script path exactly as listed by read_skill (e.g. 'scripts/fetch.sh')."),
      args: z.array(z.string()).optional().describe("Command-line arguments for the script, if its instructions call for any."),
    }),
    execute: async ({ skill, script, args }) => {
      const r = await runSkillScript(skill.trim().toLowerCase(), script.trim(), args ?? []);
      if (r.error && r.exitCode === null) return { text: r.error, sources: [] as LeashSource[] };
      const parts = [
        `Script ${skill}/${script} exited with code ${r.exitCode ?? "?"}${r.error ? ` (${r.error})` : ""}.`,
        r.stdout.trim() ? `stdout:\n\`\`\`\n${r.stdout.trim()}\n\`\`\`` : "stdout: (empty)",
        r.stderr.trim() ? `stderr:\n\`\`\`\n${r.stderr.trim()}\n\`\`\`` : "",
      ].filter(Boolean);
      return {
        text: parts.join("\n\n"),
        sources: [{ kind: "graph", title: `Skill script · ${skill}/${script}`, snippet: r.stdout.slice(0, 200) }] as LeashSource[],
      };
    },
  }),
};
