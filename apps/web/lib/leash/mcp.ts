/**
 * MCP tool layer (server-only) — config-driven, empty by default.
 *
 * Any MCP servers listed in `LEASH_MCP_SERVERS` (comma-separated SSE/HTTP URLs) are
 * connected once per process and their tools merged into the assistant's registry.
 * With no servers configured this returns `{}` — an honest empty state, not a mock.
 *
 * This is the drop-in path for the roadmap: a Home Assistant MCP server (P3) or an
 * activity/watcher MCP server (P2) lights up here with zero code changes — just add its
 * URL to `LEASH_MCP_SERVERS`.
 */
import "server-only";
import type { ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";

const SERVERS = (process.env["LEASH_MCP_SERVERS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let cached: Promise<ToolSet> | null = null;

async function connect(): Promise<ToolSet> {
  if (SERVERS.length === 0) return {};
  let merged: ToolSet = {};
  for (const url of SERVERS) {
    try {
      const client = await createMCPClient({ transport: { type: "sse", url } });
      merged = { ...merged, ...(await client.tools()) };
      console.log(`leash mcp: connected ${url}`);
    } catch (err) {
      console.error(`leash mcp: failed to connect ${url}:`, err);
    }
  }
  return merged;
}

/** Tools from configured MCP servers (connected once per process; `{}` when none). */
export function leashMcpTools(): Promise<ToolSet> {
  return (cached ??= connect());
}
