/**
 * MCP server config (server-only) — `data/leash-mcp.json`.
 *
 * Three provenances, merged on every read (built-ins first, then env, then user rows):
 *   · BUILT-IN  (`builtin: true`)  — code-defined (mesh tools), non-deletable; only its
 *                                    enabled bit persists, under `builtins[<id>]`.
 *   · ENV       (`fromEnv: true`)  — seeded from `LEASH_MCP_SERVERS` (comma-separated
 *                                    URLs), read-only (`id: "env:<url>"`).
 *   · STORED                       — the user's editable list under `servers[]`.
 *
 * File shape: `{ "servers": [...], "builtins": { "builtin:mesh-tools": { "enabled": true } } }`.
 * Validation/normalization lives in the pure `mcp-config.ts` (one code path, shared with
 * the modal + smoke); this module owns only persistence + the merge.
 */
import "server-only";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import { validateServerInput, validateUserIcon, serverSignature, type McpServerEntry, type McpServerInput, type McpTransport } from "./mcp-config.ts";
import { MCP_BUILTINS, builtinById, builtinEntry } from "./mcp-builtins.ts";

export type { McpServerEntry, McpTransport } from "./mcp-config.ts";

export const MCP_FILE = process.env["LEASH_MCP_FILE"] ?? join(DATA_DIR, "leash-mcp.json");

interface McpConfig {
  servers?: McpServerEntry[];
  /** Per-built-in overrides; `enabled` absent → the built-in's `defaultEnabled`. `name`/`userIcon` are user display overrides. */
  builtins?: Record<string, { enabled?: boolean; name?: string; userIcon?: string }>;
}

function envServers(): McpServerEntry[] {
  return (process.env["LEASH_MCP_SERVERS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ id: `env:${url}`, name: url.replace(/^https?:\/\//, ""), url, transport: "http" as const, enabled: true, fromEnv: true }));
}

/** Defensive shape check for hand-edited / legacy rows (validation proper is in mcp-config). */
function sane(e: unknown): e is McpServerEntry {
  const s = e as McpServerEntry;
  if (!s || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.enabled !== "boolean") return false;
  if (s.transport === "http" || s.transport === "sse") return typeof s.url === "string" && /^https?:\/\//.test(s.url);
  if (s.transport === "stdio") return typeof s.command === "string" && s.command.length > 0;
  return false;
}

async function readConfig(): Promise<McpConfig> {
  return (await readJsonCached<McpConfig>(MCP_FILE, {})) ?? {};
}

async function storedServers(): Promise<McpServerEntry[]> {
  const raw = await readConfig();
  return Array.isArray(raw.servers) ? raw.servers.filter(sane) : [];
}

/**
 * Every configured server — built-ins first, then env (read-only), then the stored list.
 *
 * A stored/env row that points at the SAME target as a built-in (e.g. someone added
 * `http://127.0.0.1:11439/mcp` by hand under the old flow) is SUPPRESSED — the built-in is
 * the canonical surface for that target. If that suppressed row was enabled and the built-in
 * has no explicit override yet, the built-in inherits "enabled" so opening this tab never
 * silently tears down an already-working connection.
 */
export async function listMcpServers(): Promise<McpServerEntry[]> {
  const cfg = await readConfig();
  const stored = Array.isArray(cfg.servers) ? cfg.servers.filter(sane) : [];
  const others = [...envServers(), ...stored];
  const builtinSigs = new Set(MCP_BUILTINS.map((b) => serverSignature(b)));

  const builtins = MCP_BUILTINS.map((b) => {
    const sig = serverSignature(b);
    const ov = cfg.builtins?.[b.id];
    const inherited = others.some((o) => serverSignature(o) === sig && o.enabled);
    return builtinEntry(b, ov?.enabled ?? (inherited || b.defaultEnabled), { name: ov?.name, userIcon: ov?.userIcon });
  });
  const visibleOthers = others.filter((o) => !builtinSigs.has(serverSignature(o)));
  return [...builtins, ...visibleOthers];
}

/** Add a server (validated + normalized + deduped); returns the new entry. */
export async function addMcpServer(input: McpServerInput): Promise<McpServerEntry> {
  const normalized = validateServerInput(input);
  const sig = serverSignature(normalized);
  const existing = await listMcpServers();
  if (existing.some((s) => serverSignature(s) === sig)) {
    throw new Error(normalized.transport === "stdio" ? `a server running "${normalized.command}" is already configured` : `a server with URL ${normalized.url} is already configured`);
  }
  const entry: McpServerEntry = { id: randomUUID(), enabled: true, ...normalized };
  const servers = await storedServers();
  await writeJson(MCP_FILE, { ...(await readConfig()), servers: [...servers, entry] });
  invalidateJsonCache(MCP_FILE);
  return entry;
}

/** Persist a built-in's enabled override (preserving any name/icon override); returns the materialized entry. */
export async function setBuiltinEnabled(id: string, enabled: boolean): Promise<McpServerEntry> {
  const b = builtinById(id);
  if (!b) throw new Error(`unknown built-in "${id}"`);
  const cfg = await readConfig();
  const ov = cfg.builtins?.[id];
  await writeJson(MCP_FILE, { ...cfg, builtins: { ...cfg.builtins, [id]: { ...ov, enabled } } });
  invalidateJsonCache(MCP_FILE);
  return builtinEntry(b, enabled, { name: ov?.name, userIcon: ov?.userIcon });
}

/** Persist a built-in's display overrides (name / icon). Connection stays code-defined. */
async function patchBuiltin(id: string, patch: McpServerPatch): Promise<McpServerEntry> {
  const b = builtinById(id);
  if (!b) throw new Error(`unknown built-in "${id}"`);
  const cfg = await readConfig();
  const next = { ...(cfg.builtins?.[id] ?? {}) };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.name === "string") {
    const n = patch.name.trim();
    if (n && n !== b.name) next.name = n;
    else delete next.name;
  }
  if ("userIcon" in patch) {
    const icon = validateUserIcon(patch.userIcon);
    if (icon) next.userIcon = icon;
    else delete next.userIcon;
  }
  await writeJson(MCP_FILE, { ...cfg, builtins: { ...cfg.builtins, [id]: next } });
  invalidateJsonCache(MCP_FILE);
  return builtinEntry(b, next.enabled ?? b.defaultEnabled, { name: next.name, userIcon: next.userIcon });
}

/** Fields an update may carry. A bare `{enabled}`/`{name}` is a light patch; any connection field (`transport`…) re-validates the whole row. */
export interface McpServerPatch {
  enabled?: boolean;
  name?: string;
  transport?: McpTransport | string;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Present (even empty `""`) → set or clear the user icon. */
  userIcon?: string;
}

/** Merge submitted secrets over existing ones (submitted wins; untouched keys preserved). Empty → undefined. */
function mergeSecrets(prev: Record<string, string> | undefined, incoming: Record<string, string> | undefined): Record<string, string> | undefined {
  const merged = { ...(prev ?? {}), ...(incoming ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * Update a server. Built-ins: only display name/icon (and enabled) — connection is code-defined.
 * Env rows: read-only. Stored rows: a bare enabled/name patch, or — when any connection field is
 * present — a full re-validation (with secret VALUES preserved unless re-entered; transport change
 * resets them) + a de-dupe against the rest of the set.
 */
export async function updateMcpServer(id: string, patch: McpServerPatch): Promise<McpServerEntry | null> {
  if (builtinById(id)) return patchBuiltin(id, patch);
  if (id.startsWith("env:")) throw new Error("env-configured servers are read-only — edit LEASH_MCP_SERVERS instead");
  const servers = await storedServers();
  const i = servers.findIndex((s) => s.id === id);
  if (i === -1) return null;
  const cur = servers[i] as McpServerEntry;

  // A connection edit (transport carried by the modal) re-validates everything; otherwise it's a light patch.
  const fullEdit = patch.transport !== undefined;
  let next: McpServerEntry;
  if (fullEdit) {
    const n = validateServerInput(patch);
    next = { ...n, id: cur.id, enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled };
    const transportUnchanged = n.transport === cur.transport;
    if (n.transport === "stdio") {
      next.env = mergeSecrets(transportUnchanged ? cur.env : undefined, n.env);
    } else {
      next.headers = mergeSecrets(transportUnchanged ? cur.headers : undefined, n.headers);
    }
    const sig = serverSignature(next);
    if ((await listMcpServers()).some((s) => s.id !== id && serverSignature(s) === sig)) {
      throw new Error(next.transport === "stdio" ? `a server running "${next.command}" is already configured` : `a server with URL ${next.url} is already configured`);
    }
  } else {
    next = {
      ...cur,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(typeof patch.name === "string" && patch.name.trim() ? { name: patch.name.trim() } : {}),
    };
  }
  servers[i] = next;
  await writeJson(MCP_FILE, { ...(await readConfig()), servers });
  invalidateJsonCache(MCP_FILE);
  return next;
}

/** Remove a stored row. Built-ins (turn off instead) and env rows are non-deletable. */
export async function removeMcpServer(id: string): Promise<boolean> {
  if (builtinById(id)) throw new Error("built-in servers can't be removed — turn it off instead");
  if (id.startsWith("env:")) throw new Error("env-configured servers are read-only — edit LEASH_MCP_SERVERS instead");
  const servers = await storedServers();
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) return false;
  await writeJson(MCP_FILE, { ...(await readConfig()), servers: next });
  invalidateJsonCache(MCP_FILE);
  return true;
}
