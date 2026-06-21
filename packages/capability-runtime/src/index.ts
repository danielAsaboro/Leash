import { parseLineList, parseToolList, splitFrontmatter } from "../../leash-core/src/frontmatter";
import { parseMcpJson, validateServerInput, type McpServerInput, type McpServerEntry, type NormalizedServer } from "../../leash-core/src/mcp-config";

export type { McpServerInput, McpServerEntry, NormalizedServer } from "../../leash-core/src/mcp-config";

export type CapabilitySource = "local" | "plugin";
export type CapabilityMemoryScope = "" | "user" | "project" | "local";

export interface CapabilitySkill {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  body: string;
  tools: string[];
  steps: string[];
  examples: string[];
  whenToUse: string;
  builtin: boolean;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  files: string[];
  extras: Record<string, string>;
  source: CapabilitySource;
  pluginId: string;
}

export interface CapabilityAgentMcpServers {
  refs: string[];
  inline: NormalizedServer[];
}

export interface CapabilityAgent {
  slug: string;
  source: CapabilitySource;
  pluginId: string;
  name: string;
  description: string;
  body: string;
  model: string;
  tools: string[];
  disallowedTools: string[];
  skills: string[];
  maxTurns: number;
  enabled: boolean;
  builtin: boolean;
  mcpServers: CapabilityAgentMcpServers;
  memory: CapabilityMemoryScope;
  permissionMode: string;
  hooks: string;
  background: boolean;
  effort: string;
  isolation: string;
  color: string;
  initialPrompt: string;
}

export interface CapabilityPluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
}

export interface CapabilityPlugin {
  id: string;
  name: string;
  enabled: boolean;
  version?: string;
  description?: string;
  installedAt: number;
  skills: CapabilitySkill[];
  agents: CapabilityAgent[];
  mcpServers: McpServerEntry[];
}

export interface CapabilityToolDescriptor {
  name: string;
  description: string;
  askFirstDefault?: boolean;
}

export interface CapabilityToolState {
  disabled?: string[];
  askFirst?: Record<string, boolean>;
}

export interface CapabilityToolRow extends CapabilityToolDescriptor {
  enabled: boolean;
  askFirst: boolean;
  askFirstDefault: boolean;
}

export interface CapabilityInventory {
  skills: CapabilitySkill[];
  agents: CapabilityAgent[];
  plugins: CapabilityPlugin[];
  mcpServers: McpServerEntry[];
  tools: CapabilityToolRow[];
}

const MAX_AGENT_TURNS = 16;
const SKILL_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "paths",
  "shell",
  "hooks",
  "steps",
]);
const AGENT_KEYS = new Set([
  "name",
  "description",
  "model",
  "tools",
  "disallowed-tools",
  "skills",
  "max-turns",
  "enabled",
  "builtin",
  "mcpservers",
  "mcp-servers",
  "memory",
  "permissionmode",
  "permission-mode",
  "hooks",
  "background",
  "effort",
  "isolation",
  "color",
  "initialprompt",
  "initial-prompt",
]);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function metadataObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function metadataFlag(raw: string | undefined, key: string): boolean {
  const value = metadataObject(raw)[key];
  return value === true || value === "true";
}

function metadataExamples(raw: string | undefined): string[] {
  const value = metadataObject(raw)["examples"];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 12);
  if (typeof value === "string") return parseLineList(value, 12);
  return [];
}

function parseSkillList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\s*\[/, "")
    .replace(/\]\s*$/, "")
    .split(/[\s,]+/)
    .map((token) => token.trim().replace(/^["']|["']$/g, ""))
    .filter((token) => /^[a-z0-9][a-z0-9:-]*$/.test(token));
}

function parseMaxTurns(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 6;
  return Math.min(n, MAX_AGENT_TURNS);
}

function parseMemoryScope(raw: string | undefined): CapabilityMemoryScope {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "user" || s === "project" || s === "local" ? s : "";
}

function parseAgentMcpServers(raw: string | undefined): CapabilityAgentMcpServers {
  const out: CapabilityAgentMcpServers = { refs: [], inline: [] };
  if (!raw?.trim()) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [rawName, value] of Object.entries(obj as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    const isEmpty = !value || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
    if (isEmpty) {
      out.refs.push(name);
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      try {
        out.inline.push(validateServerInput({ name, ...(value as Record<string, unknown>) }));
      } catch {
        // Skip malformed inline entries.
      }
    }
  }
  return out;
}

export function parseCapabilitySkillDocument(slug: string, raw: string): CapabilitySkill | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  for (const key of Object.keys(split.fields)) if (!SKILL_KEYS.has(key)) return null;
  const name = split.fields["name"]?.trim() ?? "";
  const description = split.fields["description"]?.trim() ?? "";
  if (!name || !description) return null;
  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(split.fields)) {
    if (key !== "name" && key !== "description") extras[key] = value;
  }
  return {
    slug,
    name,
    description,
    enabled: true,
    body: split.body,
    tools: parseToolList(split.fields["allowed-tools"]),
    steps: parseLineList(split.fields["steps"], 12),
    examples: metadataExamples(split.fields["metadata"]),
    whenToUse: split.fields["when_to_use"] ?? "",
    builtin: metadataFlag(split.fields["metadata"], "builtin"),
    userInvocable: split.fields["user-invocable"] !== "false",
    disableModelInvocation: split.fields["disable-model-invocation"] === "true",
    files: [],
    extras,
    source: "local",
    pluginId: "",
  };
}

export function parseCapabilityAgentDocument(slug: string, raw: string): CapabilityAgent | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  for (const key of Object.keys(split.fields)) if (!AGENT_KEYS.has(key)) return null;
  return {
    slug,
    source: "local",
    pluginId: "",
    name: split.fields["name"]?.trim() || slug,
    description: split.fields["description"]?.trim() ?? "",
    body: split.body,
    model: split.fields["model"]?.trim() ?? "",
    tools: parseToolList(split.fields["tools"]),
    disallowedTools: parseToolList(split.fields["disallowed-tools"]),
    skills: parseSkillList(split.fields["skills"]),
    maxTurns: parseMaxTurns(split.fields["max-turns"]),
    enabled: split.fields["enabled"] !== "false",
    builtin: split.fields["builtin"] === "true",
    mcpServers: parseAgentMcpServers(split.fields["mcpservers"] ?? split.fields["mcp-servers"]),
    memory: parseMemoryScope(split.fields["memory"]),
    permissionMode: (split.fields["permissionmode"] ?? split.fields["permission-mode"] ?? "").trim(),
    hooks: (split.fields["hooks"] ?? "").trim(),
    background: (split.fields["background"] ?? "").trim() === "true",
    effort: (split.fields["effort"] ?? "").trim(),
    isolation: (split.fields["isolation"] ?? "").trim(),
    color: (split.fields["color"] ?? "").trim(),
    initialPrompt: (split.fields["initialprompt"] ?? split.fields["initial-prompt"] ?? "").trim(),
  };
}

export function parseCapabilityPluginManifest(raw: string): CapabilityPluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid plugin.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("plugin.json must be a JSON object");
  const root = parsed as Record<string, unknown>;
  const name = typeof root["name"] === "string" ? root["name"].trim() : "";
  if (!name) throw new Error('plugin.json needs a non-empty "name"');
  const manifest: CapabilityPluginManifest = {
    id: slugify(name),
    name,
  };
  if (typeof root["version"] === "string" && root["version"].trim()) manifest.version = root["version"].trim();
  if (typeof root["description"] === "string" && root["description"].trim()) manifest.description = root["description"].trim();
  const mcp = root["mcpServers"];
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) manifest.mcpServers = mcp as Record<string, Record<string, unknown>>;
  return manifest;
}

export function validateMobileMcpServerInput(input: McpServerInput): NormalizedServer {
  const normalized = validateServerInput(input);
  if (normalized.transport === "stdio") throw new Error("mobile runtime supports only http and sse MCP transports");
  return normalized;
}

export function parseMobileMcpJson(text: string): ReturnType<typeof parseMcpJson> {
  const parsed = parseMcpJson(text);
  return {
    ready: parsed.ready.filter((entry) => entry.server.transport !== "stdio"),
    errors: [
      ...parsed.errors,
      ...parsed.ready
        .filter((entry) => entry.server.transport === "stdio")
        .map((entry) => ({ key: entry.key, error: "mobile runtime supports only http and sse MCP transports" })),
    ],
  };
}

export function mergeToolState(toolCatalog: CapabilityToolDescriptor[], state: CapabilityToolState = {}): CapabilityToolRow[] {
  const disabled = new Set(state.disabled ?? []);
  const askFirst = state.askFirst ?? {};
  return [...toolCatalog]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const askFirstDefault = tool.askFirstDefault === true;
      return {
        ...tool,
        enabled: !disabled.has(tool.name),
        askFirst: askFirst[tool.name] ?? askFirstDefault,
        askFirstDefault,
      };
    });
}

export function buildCapabilityInventory(input: {
  skills: CapabilitySkill[];
  agents: CapabilityAgent[];
  plugins: CapabilityPlugin[];
  mcpServers: McpServerEntry[];
  toolCatalog: CapabilityToolDescriptor[];
  toolState?: CapabilityToolState;
}): CapabilityInventory {
  const pluginSkills = input.plugins.flatMap((plugin) =>
    plugin.skills.map((skill) => ({
      ...skill,
      source: "plugin" as const,
      pluginId: plugin.id,
      enabled: plugin.enabled && skill.enabled,
    })),
  );
  const pluginAgents = input.plugins.flatMap((plugin) =>
    plugin.agents.map((agent) => ({
      ...agent,
      source: "plugin" as const,
      pluginId: plugin.id,
      enabled: plugin.enabled && agent.enabled,
    })),
  );
  const pluginMcpServers = input.plugins.flatMap((plugin) =>
    plugin.mcpServers.map((server) => ({
      ...server,
      enabled: plugin.enabled && server.enabled,
    })),
  );

  return {
    skills: [...input.skills, ...pluginSkills].sort((a, b) => a.name.localeCompare(b.name)),
    agents: [...input.agents, ...pluginAgents].sort((a, b) => a.name.localeCompare(b.name)),
    plugins: [...input.plugins].sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers: [...input.mcpServers, ...pluginMcpServers].sort((a, b) => a.name.localeCompare(b.name)),
    tools: mergeToolState(input.toolCatalog, input.toolState),
  };
}
