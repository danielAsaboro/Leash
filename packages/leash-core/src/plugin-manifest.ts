/**
 * Plugin & marketplace manifest parsing — shared types + pure helpers (NO `server-only`, NO
 * `node:*`), mirroring `mcp-config.ts`. Imported by the loader, the store, the API routes, and
 * (potentially) the dashboard's install preview, so it stays isomorphic.
 *
 * Format is Claude-Code-compatible:
 *   · `.claude-plugin/plugin.json` — `{ name (required), version?, description?, author?,
 *     homepage?, license?, mcpServers? }`. `mcpServers` may be INLINE here (a map) — the loader
 *     also auto-discovers a sibling `.mcp.json`.
 *   · `marketplace.json` — `{ name, owner?, plugins: [{ name, source, description?, version? }] }`,
 *     where `source` is a string ("owner/repo", a GitHub URL, or "mesh:<id>") or an object
 *     (`{ source: "github", repo }` / `{ source: "mesh", pluginId }` / `{ source: "...path" }`).
 *
 * `${CLAUDE_PLUGIN_ROOT}` in a server's command/args/cwd/env is stored UNEXPANDED on disk and
 * expanded to the absolute `data/leash-plugins/<id>/` path at LOAD — so a moved `data/` dir never
 * bricks plugin MCP commands (the design's stored-unexpanded rule).
 */

/**
 * Namespaced plugin-component slug `<plugin-id>:<name>` (both lowercase-kebab). The `:` is FORBIDDEN
 * by SKILLS_DIR's `SLUG_RE`, so a namespaced plugin slug can never collide with a user-created skill.
 * Shared by the skills slug dispatcher AND the agents store.
 */
export const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

/** Split `<plugin-id>:<name>` into its parts. Null when `slug` isn't a namespaced plugin slug. */
export function parsePluginSlug(slug: string): { id: string; name: string } | null {
  if (!PLUGIN_SLUG_RE.test(slug)) return null;
  const i = slug.indexOf(":");
  return { id: slug.slice(0, i), name: slug.slice(i + 1) };
}

/** Where a plugin came from — persisted on the registry row, parallel to MCP's `env:`/`builtin:` prefixes. */
export type PluginSourceKind = "folder" | "upload" | "github" | "mesh" | "marketplace";

/** A pointer to a plugin source: the kind plus a kind-specific reference (a path, a GitHub URL, a mesh id). */
export interface PluginSourceRef {
  kind: PluginSourceKind;
  ref: string;
}

/** The parsed `.claude-plugin/plugin.json`. Only `name` is required; everything else is optional. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  /** Inline MCP servers (Claude-Code allows declaring them right in plugin.json). Merged with a sibling `.mcp.json` at load. */
  mcpServers?: Record<string, unknown>;
}

/** One marketplace entry: a named plugin plus the source that resolves it. */
export interface MarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  source: PluginSourceRef;
}

/** A parsed marketplace index (`marketplace.json`). */
export interface Marketplace {
  name: string;
  description?: string;
  entries: MarketplaceEntry[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Author may be a plain string or `{ name, email?, url? }` (Claude-Code allows both). */
function parseAuthor(raw: unknown): string | undefined {
  if (typeof raw === "string") return str(raw);
  if (raw && typeof raw === "object") return str((raw as Record<string, unknown>)["name"]);
  return undefined;
}

/**
 * Parse a `plugin.json`'s text into a `PluginManifest`. `name` is required (and must be a
 * non-empty string); a missing/blank name throws a human message. Unknown keys are ignored.
 * Throws on non-object / unparseable JSON.
 */
export function parsePluginManifest(text: string): PluginManifest {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid plugin.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("plugin.json must be a JSON object");
  const o = root as Record<string, unknown>;
  const name = str(o["name"]);
  if (!name) throw new Error("plugin.json needs a non-empty \"name\"");
  const manifest: PluginManifest = { name };
  const version = str(o["version"]);
  if (version) manifest.version = version;
  const description = str(o["description"]);
  if (description) manifest.description = description;
  const author = parseAuthor(o["author"]);
  if (author) manifest.author = author;
  const homepage = str(o["homepage"]);
  if (homepage) manifest.homepage = homepage;
  const license = str(o["license"]);
  if (license) manifest.license = license;
  const mcp = o["mcpServers"];
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) manifest.mcpServers = mcp as Record<string, unknown>;
  return manifest;
}

/** Normalize a marketplace `source` (string or object form) into a `PluginSourceRef`. Null when unrecognized. */
export function parseSourceRef(raw: unknown): PluginSourceRef | null {
  if (typeof raw === "string") {
    const v = raw.trim();
    if (!v) return null;
    if (v.startsWith("mesh:")) return { kind: "mesh", ref: v.slice("mesh:".length) };
    // A GitHub URL, or the bare "owner/repo" shorthand → github.
    if (/^https?:\/\//i.test(v) || /^[\w.-]+\/[\w.-]+$/.test(v)) {
      return { kind: "github", ref: /^https?:\/\//i.test(v) ? v : `https://github.com/${v}` };
    }
    // A relative/absolute path → a local folder source (a marketplace shipped alongside plugins).
    return { kind: "folder", ref: v };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const kind = str(o["source"]) ?? str(o["kind"]);
    if (kind === "mesh") {
      const ref = str(o["pluginId"]) ?? str(o["ref"]) ?? str(o["id"]);
      return ref ? { kind: "mesh", ref } : null;
    }
    if (kind === "github") {
      const repo = str(o["repo"]) ?? str(o["url"]) ?? str(o["ref"]);
      if (!repo) return null;
      return { kind: "github", ref: /^https?:\/\//i.test(repo) ? repo : `https://github.com/${repo}` };
    }
    // Otherwise treat any leftover path-ish field as a folder source.
    const path = str(o["path"]) ?? str(o["source"]) ?? str(o["ref"]);
    return path ? { kind: "folder", ref: path } : null;
  }
  return null;
}

/**
 * Parse a `marketplace.json`'s text into a `Marketplace`. Requires a top-level `name` and a
 * `plugins` array; entries without a resolvable `name`+`source` are dropped (lenient, like
 * `parseMcpJson`). Throws only when the whole text isn't a JSON object.
 */
export function parseMarketplaceJson(text: string): Marketplace {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid marketplace.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("marketplace.json must be a JSON object");
  const o = root as Record<string, unknown>;
  const name = str(o["name"]);
  if (!name) throw new Error("marketplace.json needs a \"name\"");
  const rawPlugins = Array.isArray(o["plugins"]) ? (o["plugins"] as unknown[]) : [];
  const entries: MarketplaceEntry[] = [];
  for (const raw of rawPlugins) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const entryName = str(e["name"]);
    const source = parseSourceRef(e["source"]);
    if (!entryName || !source) continue;
    const entry: MarketplaceEntry = { name: entryName, source };
    const description = str(e["description"]);
    if (description) entry.description = description;
    const version = str(e["version"]);
    if (version) entry.version = version;
    entries.push(entry);
  }
  const market: Marketplace = { name, entries };
  const description = str(o["description"]);
  if (description) market.description = description;
  return market;
}

/** The Claude-Code variable that resolves to a plugin's install root. */
export const CLAUDE_PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";

/** Replace every `${CLAUDE_PLUGIN_ROOT}` in a string with the absolute plugin root. */
export function expandRoot(value: string, root: string): string {
  return value.split(CLAUDE_PLUGIN_ROOT_VAR).join(root);
}

/** A loosely-typed MCP server config object as it appears in `.mcp.json` / `plugin.json.mcpServers`. */
export interface RawMcpServerConfig {
  type?: string;
  transport?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

/**
 * Expand `${CLAUDE_PLUGIN_ROOT}` everywhere it can legally appear in ONE server config —
 * `command`, every `args` entry, `cwd`, and every `env`/`headers` value. Returns a fresh object
 * (never mutates the stored config). Call this at LOAD with the absolute plugin dir.
 */
export function expandServerRoot(server: RawMcpServerConfig, root: string): RawMcpServerConfig {
  const out: RawMcpServerConfig = { ...server };
  if (typeof out.command === "string") out.command = expandRoot(out.command, root);
  if (typeof out.cwd === "string") out.cwd = expandRoot(out.cwd, root);
  if (Array.isArray(out.args)) out.args = out.args.map((a) => (typeof a === "string" ? expandRoot(a, root) : a));
  if (out.env && typeof out.env === "object") {
    out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, typeof v === "string" ? expandRoot(v, root) : v]));
  }
  if (out.headers && typeof out.headers === "object") {
    out.headers = Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, typeof v === "string" ? expandRoot(v, root) : v]));
  }
  return out;
}
