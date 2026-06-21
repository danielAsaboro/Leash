import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

import type { McpServerEntry } from "../../../../packages/capability-runtime/src/index";

export interface MobileMcpStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: McpServerEntry["transport"];
  tools: string[];
  error?: string;
}

type Connection = {
  signature: string;
  client: MCPClient;
  tools: ToolSet;
};

const CACHE = new Map<string, Connection>();
const FETCH_NO_STORE: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

function signature(server: McpServerEntry): string {
  return `${server.transport}:${server.url ?? ""}`;
}

async function closeRemoved(desiredIds: Set<string>): Promise<void> {
  for (const [id, conn] of CACHE.entries()) {
    if (desiredIds.has(id)) continue;
    await conn.client.close().catch(() => {});
    CACHE.delete(id);
  }
}

async function connectOne(server: McpServerEntry): Promise<Connection> {
  const current = CACHE.get(server.id);
  const sig = signature(server);
  if (current && current.signature === sig) return current;
  if (current) {
    await current.client.close().catch(() => {});
    CACHE.delete(server.id);
  }
  const client = await createMCPClient({
    transport: { type: server.transport, url: server.url, fetch: FETCH_NO_STORE } as any,
  });
  const tools = (await client.tools()) as ToolSet;
  const next = { signature: sig, client, tools };
  CACHE.set(server.id, next);
  return next;
}

export async function loadMobileMcpTools(servers: McpServerEntry[]): Promise<{ tools: ToolSet; statuses: MobileMcpStatus[] }> {
  const enabled = servers.filter((server) => server.enabled && (server.transport === "http" || server.transport === "sse"));
  await closeRemoved(new Set(enabled.map((server) => server.id)));

  const merged: ToolSet = {};
  const statuses: MobileMcpStatus[] = [];

  for (const server of servers) {
    if (!server.enabled) {
      statuses.push({ id: server.id, name: server.name, enabled: false, connected: false, transport: server.transport, tools: [] });
      continue;
    }
    if (server.transport !== "http" && server.transport !== "sse") {
      statuses.push({
        id: server.id,
        name: server.name,
        enabled: true,
        connected: false,
        transport: server.transport,
        tools: [],
        error: "Mobile supports only HTTP and SSE MCP servers.",
      });
      continue;
    }
    try {
      const conn = await connectOne(server);
      Object.assign(merged, conn.tools);
      statuses.push({
        id: server.id,
        name: server.name,
        enabled: true,
        connected: true,
        transport: server.transport,
        tools: Object.keys(conn.tools).sort(),
      });
    } catch (error) {
      statuses.push({
        id: server.id,
        name: server.name,
        enabled: true,
        connected: false,
        transport: server.transport,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { tools: merged, statuses };
}
