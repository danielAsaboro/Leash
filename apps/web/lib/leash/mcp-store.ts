/**
 * MCP server config (server-only) — `data/leash-mcp.json`, shape `{ "servers": [...] }`.
 *
 * The dashboard's editable list of MCP servers the assistant connects to. Entries from
 * the `LEASH_MCP_SERVERS` env (comma-separated URLs — the original config surface) are
 * seeded into every read as READ-ONLY rows (`id: "env:<url>"`) so the dashboard always
 * shows what chat truly has; they can't be edited or removed from the UI.
 */
import "server-only";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";

export const MCP_FILE = process.env["LEASH_MCP_FILE"] ?? join(DATA_DIR, "leash-mcp.json");

export interface McpServerEntry {
  id: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  /** True for env-seeded rows — read-only in the dashboard. */
  fromEnv?: boolean;
}

interface McpConfig {
  servers: McpServerEntry[];
}

function envServers(): McpServerEntry[] {
  return (process.env["LEASH_MCP_SERVERS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ id: `env:${url}`, name: url.replace(/^https?:\/\//, ""), url, transport: "sse" as const, enabled: true, fromEnv: true }));
}

function sane(e: unknown): e is McpServerEntry {
  const s = e as McpServerEntry;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.url === "string" &&
    /^https?:\/\//.test(s.url) &&
    (s.transport === "http" || s.transport === "sse") &&
    typeof s.enabled === "boolean"
  );
}

async function storedServers(): Promise<McpServerEntry[]> {
  const raw = await readJsonCached<McpConfig>(MCP_FILE, { servers: [] });
  return Array.isArray(raw?.servers) ? raw.servers.filter(sane) : [];
}

/** Every configured server — env rows first (read-only), then the stored list. */
export async function listMcpServers(): Promise<McpServerEntry[]> {
  return [...envServers(), ...(await storedServers())];
}

/** Add a server (validated); returns the new entry. */
export async function addMcpServer(input: { name?: string; url: string; transport?: "http" | "sse" }): Promise<McpServerEntry> {
  const url = input.url.trim();
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error("url must be an http(s) URL");
  const entry: McpServerEntry = {
    id: randomUUID(),
    name: (input.name ?? "").trim() || url.replace(/^https?:\/\//, ""),
    url,
    transport: input.transport === "sse" ? "sse" : "http",
    enabled: true,
  };
  const servers = await storedServers();
  if ([...envServers(), ...servers].some((s) => s.url === url)) throw new Error(`a server with url ${url} is already configured`);
  await writeJson(MCP_FILE, { servers: [...servers, entry] });
  invalidateJsonCache(MCP_FILE);
  return entry;
}

/** Update enabled/name on a stored row (env rows are read-only). */
export async function updateMcpServer(id: string, patch: { enabled?: boolean; name?: string }): Promise<McpServerEntry | null> {
  if (id.startsWith("env:")) throw new Error("env-configured servers are read-only — edit LEASH_MCP_SERVERS instead");
  const servers = await storedServers();
  const i = servers.findIndex((s) => s.id === id);
  if (i === -1) return null;
  const cur = servers[i] as McpServerEntry;
  const next: McpServerEntry = {
    ...cur,
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch.name === "string" && patch.name.trim() ? { name: patch.name.trim() } : {}),
  };
  servers[i] = next;
  await writeJson(MCP_FILE, { servers });
  invalidateJsonCache(MCP_FILE);
  return next;
}

/** Remove a stored row (env rows are read-only). */
export async function removeMcpServer(id: string): Promise<boolean> {
  if (id.startsWith("env:")) throw new Error("env-configured servers are read-only — edit LEASH_MCP_SERVERS instead");
  const servers = await storedServers();
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) return false;
  await writeJson(MCP_FILE, { servers: next });
  invalidateJsonCache(MCP_FILE);
  return true;
}
