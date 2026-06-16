/**
 * Plugin registry (server-only) — `data/leash-plugins.json` + the extracted trees under
 * `data/leash-plugins/<id>/`. Mirrors `mcp-store.ts`'s persistence shape.
 *
 * A plugin is registered VIRTUALLY: its skills / MCP servers / agents are NEVER copied into the
 * user's own stores. Enabled-state lives in ONE place — the registry row's `enabled` bit — and the
 * components surface by AUGMENTING the existing per-turn reads:
 *   · `pluginSkills()`     → concatenated into `listSkills()`        (skills-store.ts)
 *   · `pluginMcpServers()` → appended in `listMcpServers()`         (mcp-store.ts) → reconcile()
 *   · `pluginAgents()`     → `listAgents()` → buildAgentTools()     (agents-store.ts / chat route)
 * So enable / disable / uninstall propagate with near-zero extra wiring, and uninstall is just
 * `rm -r <dir>` + drop the row (no orphan reconciliation across leash-skills/ + leash-mcp.json).
 *
 * TRUST: every install lands DISABLED regardless of what the bundle's manifest claims (the clone of
 * the skills-import quarantine guard) — the user reviews the component inventory in the dashboard,
 * then explicitly enables.
 */
// No `import "server-only"` here: this runs in the plain-Node `leash-tools-mcp` daemon too (via
// skills-store ← groups/skills.ts). The web shim (`apps/web/lib/leash/plugins-store.ts`) adds the guard.
import { cp, rm, mkdir, readdir, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import { slugify, loadSkillFromDir, type Skill } from "./skills-store.ts";
import { loadPlugin } from "./plugin-loader.ts";
import { expandServerRoot, parsePluginSlug, type PluginSourceRef } from "./plugin-manifest.ts";
import type { McpServerEntry, NormalizedServer } from "./mcp-config.ts";
import type { Agent } from "./agents-store.ts";

export const PLUGINS_DIR = process.env["LEASH_PLUGINS_DIR"] ?? join(DATA_DIR, "leash-plugins");
export const PLUGINS_FILE = process.env["LEASH_PLUGINS_FILE"] ?? join(DATA_DIR, "leash-plugins.json");
export const MARKETPLACES_DIR = process.env["LEASH_MARKETPLACES_DIR"] ?? join(DATA_DIR, "leash-marketplaces");

/** The component inventory captured at install — names only; content is read from the tree. */
export interface PluginComponents {
  /** Skill folder names (slug suffix in `<id>:<name>`). */
  skills: string[];
  /** MCP server keys (`plugin:<id>:<key>`). */
  mcpServers: string[];
  /** Agent file base names (slug suffix in `<id>:<name>`). */
  agents: string[];
}

/** One registered plugin — the persisted row in `leash-plugins.json`. */
export interface PluginEntry {
  /** Slug of the manifest name; doubles as the dir name + namespace prefix. */
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: PluginSourceRef;
  enabled: boolean;
  components: PluginComponents;
  installedAt: number;
}

interface PluginsConfig {
  plugins?: PluginEntry[];
}

// Containment / size caps for an extracted plugin tree (defense in depth on top of source staging).
const MAX_FILES = 1000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

async function readConfig(): Promise<PluginsConfig> {
  return (await readJsonCached<PluginsConfig>(PLUGINS_FILE, {})) ?? {};
}

function sane(e: unknown): e is PluginEntry {
  const p = e as PluginEntry;
  return !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.enabled === "boolean" && !!p.components && Array.isArray(p.components.skills);
}

/** Every registered plugin (install order). */
export async function listPlugins(): Promise<PluginEntry[]> {
  const cfg = await readConfig();
  return Array.isArray(cfg.plugins) ? cfg.plugins.filter(sane) : [];
}

/** One plugin by id, or null. */
export async function getPlugin(id: string): Promise<PluginEntry | null> {
  return (await listPlugins()).find((p) => p.id === id) ?? null;
}

/** Does an ENABLED plugin with this id exist? (consulted by the skills slug dispatcher). */
export async function pluginEnabled(id: string): Promise<boolean> {
  const p = await getPlugin(id);
  return !!p && p.enabled;
}

/** Flip a plugin's enabled bit. Returns the updated row, or null when the id is unknown. */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<PluginEntry | null> {
  const plugins = await listPlugins();
  const i = plugins.findIndex((p) => p.id === id);
  if (i === -1) return null;
  const next = { ...(plugins[i] as PluginEntry), enabled };
  plugins[i] = next;
  await writeJson(PLUGINS_FILE, { ...(await readConfig()), plugins });
  invalidateJsonCache(PLUGINS_FILE);
  return next;
}

/** Uninstall: drop the row AND remove the extracted tree (no orphans to reconcile). */
export async function removePlugin(id: string): Promise<boolean> {
  const plugins = await listPlugins();
  const next = plugins.filter((p) => p.id !== id);
  const removed = next.length !== plugins.length;
  if (removed) {
    await writeJson(PLUGINS_FILE, { ...(await readConfig()), plugins: next });
    invalidateJsonCache(PLUGINS_FILE);
  }
  try {
    await rm(join(PLUGINS_DIR, id), { recursive: true, force: true });
  } catch {
    /* tree already gone */
  }
  return removed;
}

/**
 * Walk an extracted tree and assert it's safe to adopt: bounded file count + total size, and NO
 * symlink may resolve outside the tree (a malicious bundle can't smuggle an escape in). Throws a
 * human message on any violation. (A path-traversal `..` can't arrive via `readdir` names — they are
 * single segments — so symlink containment + caps are the real guards here.)
 */
async function assertSafeTree(root: string): Promise<void> {
  const rootReal = await realpath(root);
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("plugin tree is nested too deeply");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) {
        let real: string;
        try {
          real = await realpath(abs);
        } catch {
          throw new Error(`broken symlink in plugin: ${e.name}`);
        }
        if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error(`plugin symlink escapes its folder: ${e.name}`);
        continue; // don't follow it
      }
      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (e.isFile()) {
        if (++files > MAX_FILES) throw new Error(`plugin has too many files (> ${MAX_FILES})`);
        bytes += (await lstat(abs)).size;
        if (bytes > MAX_TOTAL_BYTES) throw new Error(`plugin is too large (> ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB)`);
      }
    }
  };
  await walk(root, 1);
}

function existsError(id: string): Error {
  const err = new Error(`a plugin "${id}" is already installed — uninstall it first to reinstall`);
  (err as Error & { code?: string }).code = "exists";
  return err;
}

/**
 * THE single install choke-point. A `PluginSource` stages an extracted tree at `stagedDir`; this
 * validates it, derives the id from the manifest name, builds the component inventory, moves the tree
 * into `PLUGINS_DIR/<id>/`, and writes the registry row — ALWAYS `enabled:false` (quarantine), no
 * matter what the bundle claims. Throws `code:"exists"` on an id clash (uninstall to reinstall).
 * Caller owns `stagedDir`'s cleanup (best-effort `rm` on both success and failure).
 */
export async function installStagedPlugin(stagedDir: string, source: PluginSourceRef): Promise<PluginEntry> {
  await assertSafeTree(stagedDir);
  const loaded = await loadPlugin(stagedDir);
  const id = slugify(loaded.manifest.name);
  if (!id) throw new Error(`the plugin name "${loaded.manifest.name}" doesn't make a valid id`);
  if ((await getPlugin(id)) || existsSync(join(PLUGINS_DIR, id))) throw existsError(id);
  if (loaded.skills.length + loaded.mcpServers.length + loaded.agents.length === 0) {
    throw new Error("nothing to install — the bundle has no skills, MCP servers, or agents");
  }

  const dest = join(PLUGINS_DIR, id);
  await mkdir(PLUGINS_DIR, { recursive: true });
  // Copy then drop the staged tree (cross-device safe; staging may live in os tmp).
  await cp(stagedDir, dest, { recursive: true });

  const entry: PluginEntry = {
    id,
    name: loaded.manifest.name,
    ...(loaded.manifest.version ? { version: loaded.manifest.version } : {}),
    ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
    source,
    enabled: false, // quarantine — review then enable
    components: {
      skills: loaded.skills,
      mcpServers: loaded.mcpServers.map((m) => m.key),
      agents: loaded.agents.map((a) => parsePluginSlug(a.slug)?.name ?? a.slug),
    },
    installedAt: Date.now(),
  };
  const plugins = await listPlugins();
  await writeJson(PLUGINS_FILE, { ...(await readConfig()), plugins: [...plugins, entry] });
  invalidateJsonCache(PLUGINS_FILE);
  return entry;
}

// ── Virtual surfacers (augment the existing per-turn reads) ──────────────────────

/** Every installed plugin's skills, namespaced `<id>:<name>`, enabled driven by the plugin row. */
export async function pluginSkills(): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const p of await listPlugins()) {
    const dir = join(PLUGINS_DIR, p.id);
    for (const name of p.components.skills) {
      const skill = await loadSkillFromDir(join(dir, "skills", name), `${p.id}:${name}`);
      if (skill) out.push({ ...skill, enabled: p.enabled });
    }
  }
  return out;
}

/** Build a plugin MCP `McpServerEntry` from an (unexpanded) server, expanding `${CLAUDE_PLUGIN_ROOT}`. */
function toMcpEntry(id: string, key: string, server: NormalizedServer, root: string, enabled: boolean): McpServerEntry {
  const x = expandServerRoot(server, root);
  const entry: McpServerEntry = { id: `plugin:${id}:${key}`, name: server.name || `${id}:${key}`, transport: server.transport, enabled };
  if (typeof x.command === "string") entry.command = x.command;
  if (Array.isArray(x.args)) entry.args = x.args;
  if (typeof x.cwd === "string") entry.cwd = x.cwd;
  if (typeof x.url === "string") entry.url = x.url;
  if (x.env && Object.keys(x.env).length) entry.env = x.env;
  if (x.headers && Object.keys(x.headers).length) entry.headers = x.headers;
  return entry;
}

/**
 * Every installed plugin's MCP servers as `McpServerEntry`s (id `plugin:<id>:<key>`, parallel to the
 * existing `env:`/`builtin:` prefixes), `${CLAUDE_PLUGIN_ROOT}` expanded to the absolute tree, enabled
 * driven by the plugin row. They flow automatically into `mcp.ts`'s reconcile() + per-turn merge.
 */
export async function pluginMcpServers(): Promise<McpServerEntry[]> {
  const out: McpServerEntry[] = [];
  for (const p of await listPlugins()) {
    const dir = join(PLUGINS_DIR, p.id);
    const loaded = await loadPlugin(dir);
    for (const { key, server } of loaded.mcpServers) out.push(toMcpEntry(p.id, key, server, dir, p.enabled));
  }
  return out;
}

/** Every installed plugin's agents, enabled driven by the plugin row. */
export async function pluginAgents(): Promise<Agent[]> {
  const out: Agent[] = [];
  for (const p of await listPlugins()) {
    const loaded = await loadPlugin(join(PLUGINS_DIR, p.id));
    for (const agent of loaded.agents) out.push({ ...agent, enabled: p.enabled });
  }
  return out;
}
