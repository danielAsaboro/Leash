/**
 * Subagents — first-class specialized assistants, the Claude-Code "subagent" concept. Like a skill,
 * a subagent is a `---`-frontmatter markdown document; UNLIKE a skill (prose the model reads), a
 * subagent is a CALLABLE delegate: the harness exposes one tool per enabled agent (`agent-runner.ts`,
 * web side where the chat model lives) that runs the agent's body as a focused `generateText` over a
 * restricted toolset and returns just the result.
 *
 * TWO SOURCES, surfaced together (exactly like skills = user skills ∪ plugin skills):
 *   · USER agents   — `data/leash-agents/<slug>.md` (created/edited in the dashboard). Slug is a bare
 *                     kebab name; enabled unless frontmatter says `enabled: false`.
 *   · PLUGIN agents — an enabled plugin's `agents/*.md`, namespaced `<plugin-id>:<name>` (the `:` can
 *                     never collide with a user slug — SLUG_RE forbids it); enabled driven by the row.
 * `listAgents()` returns BOTH (all of them, with their enabled flags); callers filter to `.enabled`.
 *
 * Frontmatter: `name` (required), `description` (drives delegation), `model?` (a served chat alias),
 * `tools:` / `disallowed-tools:` (allow/deny over the live registry), `skills:` (skill slugs PRELOADED
 * into the sub-agent's context), `max-turns:` (step budget). The body is the system prompt. (Claude
 * Code's memory/hooks/permissionMode/worktree/fork don't map to the on-device single-turn loop.)
 */
// No `import "server-only"` here: leash-core modules run in the plain-Node `leash-tools-mcp` daemon
// too (it imports skills-store → plugins-store → this). The web shim adds the server-only guard.
import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./json-store.ts";
import { splitFrontmatter, parseToolList } from "./frontmatter.ts";
import { PLUGIN_SLUG_RE } from "./plugin-manifest.ts";
import { slugify } from "./skills-store.ts";
import { pluginAgents } from "./plugins-store.ts";

/** `data/leash-agents` — the user's own subagents (one `<slug>.md` each). */
export const AGENTS_DIR = process.env["LEASH_AGENTS_DIR"] ?? join(DATA_DIR, "leash-agents");

/** Default sub-agent step budget when `max-turns:` is absent (a small bounded tool loop). */
export const DEFAULT_AGENT_MAX_TURNS = 6;
/** Hard cap on `max-turns:` so a definition can't request an unbounded loop. */
const MAX_AGENT_TURNS = 16;

/** A bare user-agent slug (kebab). Same shape as a skill slug; the `:` in a plugin slug never matches. */
const USER_AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Agent {
  /** Slug — bare kebab for a user agent, namespaced `<plugin-id>:<name>` for a plugin agent. */
  slug: string;
  /** Where it came from. */
  source: "user" | "plugin";
  /** The owning plugin id (plugin agents); "" for user agents. */
  pluginId: string;
  /** Display name (frontmatter `name`). */
  name: string;
  /** What the agent does — shown in the tool description so the model knows when to delegate. */
  description: string;
  /** The agent's system prompt (markdown body). */
  body: string;
  /** Served chat alias to drive this agent (frontmatter `model:`); empty ⇒ the default chat model. */
  model: string;
  /** Allow-list of tool names the sub-agent may use (frontmatter `tools:`); empty ⇒ a sane default. */
  tools: string[];
  /** Deny-list of tool names (frontmatter `disallowed-tools:`) removed from the allow-set. */
  disallowedTools: string[];
  /** Skill slugs whose full body is PRELOADED into the sub-agent's context at startup (frontmatter `skills:`). */
  skills: string[];
  /** Step budget for the sub-agent's tool loop (`max-turns:`, clamped). */
  maxTurns: number;
  /** Enabled — user agents: frontmatter (`enabled: false` to disable); plugin agents: the plugin row. */
  enabled: boolean;
}

/** A clamped, sane `max-turns:` value (default when absent / unparseable). */
function parseMaxTurns(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AGENT_MAX_TURNS;
  return Math.min(n, MAX_AGENT_TURNS);
}

/** Parse a `skills:` value (array or comma/space list) into skill slugs — allows `:` (namespaced plugin skills). */
function parseSkillList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\s*\[/, "")
    .replace(/\]\s*$/, "")
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => /^[a-z0-9][a-z0-9:-]*$/.test(t));
}

/** Build an `Agent` from parsed frontmatter + body. Shared by the user and plugin parse paths. */
function buildAgent(slug: string, source: "user" | "plugin", pluginId: string, fields: Record<string, string>, body: string): Agent {
  return {
    slug,
    source,
    pluginId,
    name: fields["name"]?.trim() || slug,
    description: fields["description"]?.trim() ?? "",
    body,
    model: fields["model"]?.trim() ?? "",
    tools: parseToolList(fields["tools"] ?? fields["allowed-tools"]),
    disallowedTools: parseToolList(fields["disallowed-tools"] ?? fields["disallowedtools"]),
    skills: parseSkillList(fields["skills"]),
    maxTurns: parseMaxTurns(fields["max-turns"] ?? fields["maxturns"]),
    // User: enabled unless explicitly false. Plugin: the surfacer overrides with the plugin row's bit.
    enabled: fields["enabled"] !== "false",
  };
}

/**
 * Parse one PLUGIN `agents/<name>.md`. `pluginId` + `fileName` form the namespaced slug; `enabled` is
 * overridden by the plugin surfacer with the row bit. Null when the doc has no frontmatter.
 */
export function parseAgent(pluginId: string, fileName: string, raw: string): Agent | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  return buildAgent(`${pluginId}:${fileName}`, "plugin", pluginId, split.fields, split.body);
}

/** Parse one USER `<slug>.md`. Null when the doc has no frontmatter. */
function parseUserAgent(slug: string, raw: string): Agent | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  return buildAgent(slug, "user", "", split.fields, split.body);
}

function serializeAgent(a: Pick<Agent, "name" | "description" | "body" | "model" | "tools" | "disallowedTools" | "skills" | "maxTurns" | "enabled">): string {
  const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();
  let fm = `name: ${oneLine(a.name)}\ndescription: ${oneLine(a.description)}\nenabled: ${a.enabled}\n`;
  if (a.model) fm += `model: ${a.model}\n`;
  if (a.tools.length) fm += `tools: ${a.tools.join(", ")}\n`;
  if (a.disallowedTools.length) fm += `disallowed-tools: ${a.disallowedTools.join(", ")}\n`;
  if (a.skills.length) fm += `skills: ${a.skills.join(", ")}\n`;
  fm += `max-turns: ${a.maxTurns}\n`;
  return `---\n${fm}---\n\n${a.body.trim()}\n`;
}

// ── User subagents store ─────────────────────────────────────────────────────────

/** Load one user agent by slug, or null. */
export async function getUserAgent(slug: string): Promise<Agent | null> {
  if (!USER_AGENT_SLUG_RE.test(slug)) return null;
  try {
    return parseUserAgent(slug, await readFile(join(AGENTS_DIR, `${slug}.md`), "utf8"));
  } catch {
    return null;
  }
}

/** Every user agent (`[]` when the dir doesn't exist yet). */
export async function listUserAgents(): Promise<Agent[]> {
  let entries: string[];
  try {
    entries = await readdir(AGENTS_DIR);
  } catch {
    return [];
  }
  const slugs = entries.filter((e) => e.endsWith(".md")).map((e) => e.replace(/\.md$/, ""));
  const agents = await Promise.all(slugs.map((s) => getUserAgent(s)));
  return agents.filter((a): a is Agent => a !== null);
}

/** Create or replace a user agent; slug defaults to slugify(name). Returns the saved agent. */
export async function saveAgent(input: {
  slug?: string;
  name: string;
  description?: string;
  body?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  maxTurns?: number;
  enabled?: boolean;
}): Promise<Agent> {
  const slug = input.slug?.trim() || slugify(input.name);
  if (!USER_AGENT_SLUG_RE.test(slug)) throw new Error(`invalid agent slug "${slug}"`);
  if (!input.name.trim()) throw new Error("agent name is required");
  const a = {
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    body: input.body ?? "",
    model: (input.model ?? "").trim(),
    tools: input.tools ?? [],
    disallowedTools: input.disallowedTools ?? [],
    skills: input.skills ?? [],
    maxTurns: input.maxTurns ? parseMaxTurns(String(input.maxTurns)) : DEFAULT_AGENT_MAX_TURNS,
    enabled: input.enabled ?? true,
  };
  await mkdir(AGENTS_DIR, { recursive: true });
  await writeFile(join(AGENTS_DIR, `${slug}.md`), serializeAgent(a));
  return { slug, source: "user", pluginId: "", ...a };
}

/** Delete a user agent (no-op if absent). */
export async function deleteAgent(slug: string): Promise<void> {
  if (!USER_AGENT_SLUG_RE.test(slug)) return;
  try {
    await rm(join(AGENTS_DIR, `${slug}.md`));
  } catch {
    /* already gone */
  }
}

// ── Combined surface (user ∪ plugin) ─────────────────────────────────────────────

/** ALL agents, name-sorted — user agents ∪ enabled-plugin agents (with their enabled flags). Callers filter `.enabled`. */
export async function listAgents(): Promise<Agent[]> {
  const [user, plugin] = await Promise.all([listUserAgents(), pluginAgents()]);
  return [...user, ...plugin].sort((a, b) => a.name.localeCompare(b.name));
}

/** One agent by slug — dispatches to the plugin surfacer (namespaced slug) or the user store. */
export async function getAgent(slug: string): Promise<Agent | null> {
  if (PLUGIN_SLUG_RE.test(slug)) return (await pluginAgents()).find((a) => a.slug === slug) ?? null;
  return getUserAgent(slug);
}
