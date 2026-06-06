/**
 * MCP tool layer (server-only) — store-driven (Brain → MCP) + `LEASH_MCP_SERVERS` env.
 *
 * Clients are cached per server URL and reconciled against the CURRENT store snapshot
 * on every read: new enabled servers connect, removed/disabled ones are closed (their
 * pending elicitations cancelled). Each client advertises the `elicitation` capability
 * and bridges `elicitation/create` requests into the in-memory broker
 * (`elicitations.ts`) — the chat stream renders them as in-chat forms.
 *
 * With nothing configured this returns `{}` — an honest empty state, not a mock.
 */
import "server-only";
import type { ToolSet } from "ai";
import { createMCPClient, ElicitationRequestSchema, type ElicitResult, type MCPClient } from "@ai-sdk/mcp";
import { listMcpServers, type McpServerEntry } from "./mcp-store.ts";
import { requestElicitation, cancelElicitationsFor } from "./elicitations.ts";

interface Connection {
  entry: McpServerEntry;
  client: MCPClient;
  tools: ToolSet;
  toolNames: string[];
  connectedAt: number;
}

interface FailedAttempt {
  at: number;
  error: string;
}

interface Registry {
  connections: Map<string, Connection>; // keyed by url
  failures: Map<string, FailedAttempt>; // keyed by url (last failed connect, for status)
  reconciling: Promise<void> | null;
}

// On globalThis so Next dev-mode reloads reuse live connections instead of leaking them.
const g = globalThis as unknown as { __leashMcp?: Registry };
const registry: Registry = (g.__leashMcp ??= { connections: new Map(), failures: new Map(), reconciling: null });

/** How long a failed connect is remembered before we retry (avoids hammering a dead server every turn). */
const FAILURE_TTL_MS = 30_000;

async function connectOne(entry: McpServerEntry): Promise<void> {
  try {
    const client = await createMCPClient({
      transport: { type: entry.transport, url: entry.url },
      // Advertise elicitation support; server→client elicitInput lands in the broker and
      // times out to cancel there, so a tool call can pause on a human form mid-chat.
      capabilities: { elicitation: {} },
    });
    client.onElicitationRequest(
      ElicitationRequestSchema,
      (request) =>
        requestElicitation({
          serverName: entry.name,
          message: request.params.message,
          requestedSchema: request.params.requestedSchema,
        }) as Promise<ElicitResult>, // ElicitResultLike is the index-signature-free subset
    );
    const tools = await client.tools();
    registry.connections.set(entry.url, { entry, client, tools, toolNames: Object.keys(tools), connectedAt: Date.now() });
    registry.failures.delete(entry.url);
    console.log(`leash mcp: connected ${entry.name} (${entry.url}) — ${Object.keys(tools).length} tool(s)`);
  } catch (err) {
    registry.failures.set(entry.url, { at: Date.now(), error: err instanceof Error ? err.message : String(err) });
    console.error(`leash mcp: failed to connect ${entry.url}:`, err);
  }
}

async function closeOne(url: string): Promise<void> {
  const conn = registry.connections.get(url);
  if (!conn) return;
  registry.connections.delete(url);
  cancelElicitationsFor(conn.entry.name); // a form from a gone server can never be answered
  try {
    await conn.client.close();
  } catch {
    /* already dead */
  }
  console.log(`leash mcp: closed ${conn.entry.name} (${url})`);
}

/** Reconcile live connections against the store snapshot (serialized — one at a time). */
async function reconcile(): Promise<void> {
  if (registry.reconciling) return registry.reconciling;
  const run = (async () => {
    const desired = (await listMcpServers()).filter((s) => s.enabled);
    const desiredByUrl = new Map(desired.map((s) => [s.url, s]));
    // Close connections whose server is gone or disabled.
    for (const url of [...registry.connections.keys()]) {
      if (!desiredByUrl.has(url)) await closeOne(url);
    }
    // Connect new ones (respecting the failure cool-down).
    for (const entry of desired) {
      if (registry.connections.has(entry.url)) continue;
      const failed = registry.failures.get(entry.url);
      if (failed && Date.now() - failed.at < FAILURE_TTL_MS) continue;
      await connectOne(entry);
    }
  })();
  registry.reconciling = run;
  try {
    await run;
  } finally {
    registry.reconciling = null;
  }
}

/** Tools from every connected MCP server (reconciled against the store on each call). */
export async function leashMcpTools(): Promise<ToolSet> {
  await reconcile();
  let merged: ToolSet = {};
  for (const conn of registry.connections.values()) merged = { ...merged, ...conn.tools };
  return merged;
}

export interface McpServerStatus extends McpServerEntry {
  connected: boolean;
  toolNames: string[];
  /** Last connect error while disconnected (honest failure surface). */
  error?: string;
}

/** Per-server status for the dashboard (config + live connection + tool names). */
export async function mcpServerStatuses(): Promise<McpServerStatus[]> {
  await reconcile();
  const servers = await listMcpServers();
  return servers.map((s) => {
    const conn = registry.connections.get(s.url);
    const failed = registry.failures.get(s.url);
    return {
      ...s,
      connected: !!conn,
      toolNames: conn?.toolNames ?? [],
      ...(!conn && s.enabled && failed ? { error: failed.error } : {}),
    };
  });
}
