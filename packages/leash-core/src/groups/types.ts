/**
 * Shared shape for a "tool group" — one MCP server in the `leash-tools-mcp` daemon.
 *
 * A group is a self-contained capability family (Home Assistant, Feed, Memory, Tasks,
 * Context, Photos, Image). The daemon mounts each group as its own MCP server on its own
 * URL path, and the web's Brain → MCP panel toggles it as a unit. Adding a capability is
 * "drop a new module exporting a `ToolGroup` and list it in `groups/index.ts`".
 *
 * Each tool's `handler` returns the canonical `{ text, sources, ...extra }`; the daemon
 * wraps that into an MCP result (`content` text for the model + `structuredContent` for the
 * UI's citation chips), and `apps/web/lib/leash/mcp.ts` maps it back on the client side.
 */
import type { z } from "zod";
import type { ToolResult } from "../sources.ts";

export interface GroupTool {
  /** Tool name — kept IDENTICAL to the old in-process name so per-tool toggles, Ask-First
   *  gating, and stored-thread validation all keep working by name. */
  name: string;
  description: string;
  /** A Zod raw shape (`{ field: z.string() }`), the shape `McpServer.registerTool` expects. */
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /** Default to pausing on a human approval card in chat (e.g. ha_call_service side effects). */
  needsApproval?: boolean;
}

export interface ToolGroup {
  /** Stable id — the URL path segment (`/mcp/<id>`) AND the built-in suffix (`builtin:tools-<id>`). */
  id: string;
  /** Display name in Brain → MCP (e.g. "Home Assistant"). */
  label: string;
  /** One-line description for the MCP server + the built-in card. */
  description: string;
  tools: GroupTool[];
}

/** Typed-handler helper: preserves `z.infer` on the handler args while storing as a `GroupTool`. */
export function defineTool<S extends z.ZodRawShape>(t: {
  name: string;
  description: string;
  inputSchema: S;
  needsApproval?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
}): GroupTool {
  return t as unknown as GroupTool;
}
