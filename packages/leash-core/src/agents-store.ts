/**
 * Agents (server-only) — a plugin's `agents/*.md` sub-agents. Like a skill, an agent is a
 * `---`-frontmatter markdown document; UNLIKE a skill (prose the model reads), an agent is a
 * CALLABLE sub-agent: the harness exposes one tool per enabled agent (`agent-runner.ts`, web side
 * where the chat model lives) that runs the agent's body as a focused `generateText` over a
 * restricted toolset and returns just the result — the Claude-Code "subagent" concept.
 *
 * Agents are a PLUGIN-ONLY component (there is no user-level agents dir): `listAgents()` surfaces
 * the agents of ENABLED plugins, exactly as `pluginSkills()`/`pluginMcpServers()` surface the
 * other two component types. Every agent slug is namespaced `<plugin-id>:<name>` — the `:` can
 * never collide with a user skill slug (SKILLS_DIR's `SLUG_RE` forbids it).
 *
 * Frontmatter: `name` (required), `description`, `model?` (a served chat alias), `tools:` /
 * `disallowed-tools:` (the allow/deny lists over the live registry), `max-turns:` (step budget).
 * The body is the agent's system prompt.
 */
// No `import "server-only"` here: leash-core modules run in the plain-Node `leash-tools-mcp` daemon
// too (it imports skills-store → plugins-store → this). The web shim adds the server-only guard.
import { splitFrontmatter, parseToolList } from "./frontmatter.ts";
import { PLUGIN_SLUG_RE } from "./plugin-manifest.ts";
import { pluginAgents } from "./plugins-store.ts";

/** Default sub-agent step budget when `max-turns:` is absent (a small bounded tool loop). */
export const DEFAULT_AGENT_MAX_TURNS = 6;
/** Hard cap on `max-turns:` so a bundle can't request an unbounded loop. */
const MAX_AGENT_TURNS = 16;

export interface Agent {
  /** Namespaced slug `<plugin-id>:<name>` — the registry/UI key. */
  slug: string;
  /** The plugin this agent belongs to. */
  pluginId: string;
  /** Display name (from frontmatter `name`). */
  name: string;
  /** What the agent does — shown in the tool description so the model knows when to call it. */
  description: string;
  /** The agent's system prompt (markdown body). */
  body: string;
  /** Served chat alias to drive this agent (frontmatter `model:`); empty ⇒ the default chat model. */
  model: string;
  /** Allow-list of tool names the sub-agent may use (frontmatter `tools:`); empty ⇒ inherit a sane default. */
  tools: string[];
  /** Deny-list of tool names (frontmatter `disallowed-tools:`) removed from the allow-set. */
  disallowedTools: string[];
  /** Step budget for the sub-agent's tool loop (`max-turns:`, clamped). */
  maxTurns: number;
  /** Driven by the owning plugin's enabled bit (set by the surfacer, not the file). */
  enabled: boolean;
}

/** A clamped, sane `max-turns:` value (default when absent / unparseable). */
function parseMaxTurns(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AGENT_MAX_TURNS;
  return Math.min(n, MAX_AGENT_TURNS);
}

/**
 * Parse one `agents/<name>.md` into an `Agent`. `pluginId` + `name` (the file's base name) form the
 * namespaced slug; the frontmatter `name` is the display name (falls back to the file name). Returns
 * null when the document has no frontmatter. `enabled` is set by the caller (the plugin's bit).
 */
export function parseAgent(pluginId: string, fileName: string, raw: string): Agent | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  const { fields, body } = split;
  return {
    slug: `${pluginId}:${fileName}`,
    pluginId,
    name: fields["name"]?.trim() || fileName,
    description: fields["description"]?.trim() ?? "",
    body,
    model: fields["model"]?.trim() ?? "",
    tools: parseToolList(fields["tools"] ?? fields["allowed-tools"]),
    disallowedTools: parseToolList(fields["disallowed-tools"] ?? fields["disallowedtools"]),
    maxTurns: parseMaxTurns(fields["max-turns"] ?? fields["maxturns"]),
    enabled: false,
  };
}

/** Every ENABLED plugin's agents, namespaced + enabled-stamped (`[]` when no plugin ships agents). */
export async function listAgents(): Promise<Agent[]> {
  return (await pluginAgents()).filter((a) => a.enabled);
}

/** One agent by its namespaced slug (enabled-filtered) — null when missing/disabled. */
export async function getAgent(slug: string): Promise<Agent | null> {
  if (!PLUGIN_SLUG_RE.test(slug)) return null;
  return (await listAgents()).find((a) => a.slug === slug) ?? null;
}
