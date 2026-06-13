/**
 * Minimal MCP config writer for the `leash-tools-mcp` MCP-admin group — appends/updates the
 * USER `servers[]` list in `data/leash-mcp.json`, cross-process-locked. It deliberately does
 * NOT touch the `builtins` map or read the web's in-memory connection registry: the web's
 * `mcp.ts` reconcile picks up the new/updated row on its next chat turn and connects it for
 * real (so this stays honest across the process boundary — see groups/mcp-admin.ts).
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson, invalidateJsonCache } from "./json-store.ts";
import { DATA_DIR } from "./paths.ts";
import { withFileLock } from "./lock.ts";
import { validateServerInput, serverSignature, type McpServerEntry, type McpServerInput } from "./mcp-config.ts";

export const MCP_FILE = process.env["LEASH_MCP_FILE"] ?? join(DATA_DIR, "leash-mcp.json");

interface McpConfig {
  servers?: McpServerEntry[];
  builtins?: Record<string, unknown>;
}

function sane(e: unknown): e is McpServerEntry {
  const s = e as McpServerEntry;
  if (!s || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.enabled !== "boolean") return false;
  if (s.transport === "http" || s.transport === "sse") return typeof s.url === "string" && /^https?:\/\//.test(s.url);
  if (s.transport === "stdio") return typeof s.command === "string" && s.command.length > 0;
  return false;
}

/** Find an existing USER server to update (by id, else exact connection signature, else name). */
function findExisting(servers: McpServerEntry[], normalized: { name: string; transport: string }, sig: string, id?: string): McpServerEntry | undefined {
  if (id) return servers.find((s) => s.id === id);
  const bySig = servers.find((s) => serverSignature(s) === sig);
  if (bySig) return bySig;
  if (normalized.name) {
    const byName = servers.find((s) => s.name.trim().toLowerCase() === normalized.name.trim().toLowerCase());
    if (byName) return byName;
  }
  return undefined;
}

/** Merge submitted secrets over existing ones (submitted wins; untouched keys preserved). */
function mergeSecrets(prev: Record<string, string> | undefined, incoming: Record<string, string> | undefined): Record<string, string> | undefined {
  const merged = { ...(prev ?? {}), ...(incoming ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

export interface AddOrUpdateResult {
  entry: McpServerEntry;
  updated: boolean;
}

/**
 * Validate + persist ONE user server (create or in-place update), cross-process-locked.
 * Returns the saved entry; the web reconcile connects it on its next turn.
 */
export async function addOrUpdateServer(input: McpServerInput & { id?: string; enabled?: boolean }): Promise<AddOrUpdateResult> {
  const normalized = validateServerInput(input);
  const sig = serverSignature(normalized);
  return withFileLock(MCP_FILE, async () => {
    const cfg = (await readJson<McpConfig>(MCP_FILE, {})) ?? {};
    const servers = (Array.isArray(cfg.servers) ? cfg.servers : []).filter(sane);
    const existing = findExisting(servers, normalized, sig, input.id);
    let entry: McpServerEntry;
    let updated = false;
    if (existing) {
      updated = true;
      const transportUnchanged = normalized.transport === existing.transport;
      entry = { ...normalized, id: existing.id, enabled: typeof input.enabled === "boolean" ? input.enabled : existing.enabled };
      if (normalized.transport === "stdio") entry.env = mergeSecrets(transportUnchanged ? existing.env : undefined, normalized.env);
      else entry.headers = mergeSecrets(transportUnchanged ? existing.headers : undefined, normalized.headers);
      const i = servers.findIndex((s) => s.id === existing.id);
      servers[i] = entry;
    } else {
      entry = { id: randomUUID(), enabled: input.enabled ?? true, ...normalized };
      servers.push(entry);
    }
    await writeJson(MCP_FILE, { ...cfg, servers });
    invalidateJsonCache(MCP_FILE);
    return { entry, updated };
  });
}
