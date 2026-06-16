/**
 * Plugin loader (server-only) — read a Claude-Code plugin tree off disk into its components.
 *
 * Auto-discovery per the Claude-Code plugin spec, all relative to the plugin root:
 *   · `.claude-plugin/plugin.json` — the manifest (optional; only `name` is required). When absent,
 *     the plugin's name defaults to the directory's base name (auto-discover).
 *   · `skills/<name>/SKILL.md`     — folder-shaped skills (we surface their NAMES; the skills store's
 *     slug dispatcher reads each one's content under the plugin tree).
 *   · `.mcp.json` (+ inline `mcpServers` in plugin.json) — MCP servers, parsed via the shared
 *     `parseMcpJson` (one validation code path). Returned UNEXPANDED — `${CLAUDE_PLUGIN_ROOT}` is
 *     expanded at surfacing time against the absolute root (so a moved `data/` never bricks them).
 *   · `agents/<name>.md`           — callable sub-agents (parsed via the agents store).
 *
 * `loadPlugin` is the single reader; the install choke-point uses it to build the inventory, and the
 * per-turn surfacers (`pluginSkills`/`pluginMcpServers`/`pluginAgents`) use it to materialize live
 * components. The plugin's id is the directory's base name (== the registry row id for installed
 * plugins), so a surfacer that loads `PLUGINS_DIR/<id>` derives the correct namespace for free.
 */
// No `import "server-only"` here: reachable from the plain-Node daemon via skills-store. The web
// shim (`apps/web/lib/leash/plugin-loader.ts`) adds the server-only guard.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { parsePluginManifest, type PluginManifest } from "./plugin-manifest.ts";
import { parseMcpJson, type NormalizedServer } from "./mcp-config.ts";
import { parseAgent, type Agent } from "./agents-store.ts";

/** One MCP server a plugin declares — its key plus the validated (but UNEXPANDED) connection config. */
export interface PluginMcpServer {
  key: string;
  server: NormalizedServer;
}

/** A plugin tree resolved into its components (UNEXPANDED — expansion happens at surfacing). */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute plugin root. */
  root: string;
  /** Id derived from the root's base name (== the registry row id for an installed plugin). */
  id: string;
  /** Skill folder names (each has a `SKILL.md`). */
  skills: string[];
  /** Parsed sub-agents (`enabled:false` — the surfacer stamps the plugin's bit). */
  agents: Agent[];
  /** Declared MCP servers (unexpanded). */
  mcpServers: PluginMcpServer[];
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The manifest at `<root>/.claude-plugin/plugin.json`, or a synthesized `{ name: <dirname> }`. */
async function readManifest(root: string): Promise<PluginManifest> {
  const text = await readIfPresent(join(root, ".claude-plugin", "plugin.json"));
  if (!text) return { name: basename(root) };
  try {
    return parsePluginManifest(text);
  } catch {
    // A malformed manifest shouldn't make the whole plugin unreadable — fall back to the dir name.
    return { name: basename(root) };
  }
}

/** Skill folder names under `<root>/skills` that actually contain a `SKILL.md`. */
async function discoverSkills(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, "skills"), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;
    try {
      await stat(join(root, "skills", e.name, "SKILL.md"));
      out.push(e.name);
    } catch {
      /* a skills/<name>/ without a SKILL.md is not a skill */
    }
  }
  return out.sort();
}

/** Parsed sub-agents from `<root>/agents/*.md` (pluginId = the root's base name). */
async function discoverAgents(root: string, id: string): Promise<Agent[]> {
  let entries;
  try {
    entries = await readdir(join(root, "agents"), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Agent[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || !e.isFile() || !e.name.endsWith(".md")) continue;
    const raw = await readIfPresent(join(root, "agents", e.name));
    if (raw == null) continue;
    const agent = parseAgent(id, e.name.replace(/\.md$/, ""), raw);
    if (agent) out.push(agent);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** MCP servers from `<root>/.mcp.json` merged with the manifest's inline `mcpServers` (unexpanded). */
export async function discoverMcpServers(root: string, manifest: PluginManifest): Promise<PluginMcpServer[]> {
  const byKey = new Map<string, NormalizedServer>();
  // Inline manifest servers first; the canonical `.mcp.json` file overrides on a key clash.
  if (manifest.mcpServers && Object.keys(manifest.mcpServers).length) {
    try {
      for (const { key, server } of parseMcpJson(JSON.stringify(manifest.mcpServers)).ready) byKey.set(key, server);
    } catch {
      /* malformed inline block — skip */
    }
  }
  const fileText = await readIfPresent(join(root, ".mcp.json"));
  if (fileText) {
    try {
      for (const { key, server } of parseMcpJson(fileText).ready) byKey.set(key, server);
    } catch {
      /* malformed .mcp.json — skip */
    }
  }
  return [...byKey.entries()].map(([key, server]) => ({ key, server }));
}

/** Read a plugin tree at `dir` into its components. Never throws — a missing component type is `[]`. */
export async function loadPlugin(dir: string): Promise<LoadedPlugin> {
  const id = basename(dir);
  const manifest = await readManifest(dir);
  const [skills, agents, mcpServers] = await Promise.all([discoverSkills(dir), discoverAgents(dir, id), discoverMcpServers(dir, manifest)]);
  return { manifest, root: dir, id, skills, agents, mcpServers };
}
