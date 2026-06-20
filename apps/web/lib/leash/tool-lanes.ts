/**
 * Tool-name "lanes" (server-only) — the chat route's intent routing and the agent's focused
 * toolset key off tool NAMES, not the tool objects. The tools themselves live in
 * MCP servers and reach chat via `leashMcpTools()` when their server is enabled, so
 * these are plain name constants the route/agent match against the merged registry.
 */
import "server-only";
import { homedir } from "node:os";

/** Open Computer Use MCP tools — the `computer` route narrows the turn to exactly these. */
export const COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_apps",
  "get_app_state",
  "click",
  "perform_secondary_action",
  "scroll",
  "drag",
  "type_text",
  "press_key",
  "set_value",
]);

/** The Files group's tool — the `files` route narrows the turn to exactly this. */
export const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(["bash"]);

/** The Health route's read-only tools: private records/memory/current context, no actions or web. */
export const HEALTH_TOOL_NAMES: ReadonlySet<string> = new Set(["search_graph", "recall", "active_context", "activity_recent"]);

/** The MCP-admin group's tools — kept OUT of the always-on chat lane (skill-gated via the
 *  `mcp-installer` skill), so MCP management costs 0 schema slots until that skill activates. */
export const MCP_ADMIN_TOOL_NAMES: ReadonlySet<string> = new Set(["install_mcp_repo", "upsert_mcp_server"]);

/** Where the sandboxed `bash` snapshots from (cosmetic dashboard note). */
const BASH_ROOT = process.env["LEASH_BASH_ROOT"] ?? homedir();

/** Static scope note for the dashboard's Files tool row. */
export function bashScopeNote(): string {
  return `Sandboxed retrieval — a read-only in-memory snapshot of your files under ${BASH_ROOT}, run in an isolated process; can't touch the real disk. Used on file-search turns.`;
}
