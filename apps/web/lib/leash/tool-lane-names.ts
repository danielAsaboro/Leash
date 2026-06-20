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

/** MCP-admin tools stay out of the always-on chat lane; the mcp-installer skill activates them. */
export const MCP_ADMIN_TOOL_NAMES: ReadonlySet<string> = new Set(["install_mcp_repo", "upsert_mcp_server", "mcp_run"]);
