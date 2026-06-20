/**
 * Tool-name "lanes" (server-only) — the chat route's intent routing and the agent's focused
 * toolset key off tool NAMES, not the tool objects. The tools themselves live in
 * MCP servers and reach chat via `leashMcpTools()` when their server is enabled, so
 * these are plain name constants the route/agent match against the merged registry.
 */
import "server-only";
import { homedir } from "node:os";
export { COMPUTER_TOOL_NAMES, BASH_TOOL_NAMES, HEALTH_TOOL_NAMES, MCP_ADMIN_TOOL_NAMES } from "./tool-lane-names.ts";

/** Where the sandboxed `bash` snapshots from (cosmetic dashboard note). */
const BASH_ROOT = process.env["LEASH_BASH_ROOT"] ?? homedir();

/** Static scope note for the dashboard's Files tool row. */
export function bashScopeNote(): string {
  return `Sandboxed retrieval — a read-only in-memory snapshot of your files under ${BASH_ROOT}, run in an isolated process; can't touch the real disk. Used on file-search turns.`;
}
