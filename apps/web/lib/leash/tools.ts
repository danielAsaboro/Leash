/**
 * Leash's in-process AI SDK tool registry (server-only).
 *
 * The capability tools that used to live here — search_graph, understory_*, list_photos,
 * generate_image, ha_*, active_context, activity_recent — have moved into the
 * `leash-tools-mcp` daemon as toggleable MCP server GROUPS (Home Assistant, Feed, Memory,
 * Tasks, Context, Photos, Image). They reach chat via `leashMcpTools()` when their group is
 * enabled in Brain → MCP, so toggling a server off takes the whole group offline.
 *
 * What stays in-process here is `mcpAdminTools` (skill-gated MCP management) — it manages the
 * MCP layer itself and so can't live behind it. The other in-process tools (skills,
 * sandboxed bash, plan) are assembled in the chat route, not here.
 *
 * `LeashSource` (the citation shape every tool returns) now lives in `@mycelium/leash-core`
 * and is re-exported here so existing `import { LeashSource } from "./tools.ts"` sites keep
 * resolving.
 */
import "server-only";
import type { ToolSet } from "ai";

export type { LeashSource } from "@mycelium/leash-core/sources";

/**
 * The in-process tool registry is now EMPTY — capabilities are reached via `leashMcpTools()`
 * or assembled as agent control-flow tools in the chat route.
 * Kept as an (empty) export so the registry-assembly sites still spread it without a special case.
 * `run_skill` / `submit_plan` are agent control-flow built in the chat route, not listed tools.
 */
export const leashTools: ToolSet = {};
