/**
 * Built-in MCP servers (server-only) — code-defined, non-deletable, lifecycle-bound.
 *
 * A built-in is a code-defined MCP server the user can toggle but never delete. Most
 * built-ins bridge to a supervised localhost daemon (`services.ts`); stdio built-ins
 * launch their own local package directly. The connection target is fixed here; only
 * enabled/name/icon overrides are persisted in `data/leash-mcp.json`.
 */
import "server-only";
import { join } from "node:path";
import { BRAIN_ALWAYS_ON_TOOL_GROUPS, BRAIN_MCP_TOOL_GROUPS } from "@mycelium/brain";
import { REPO_ROOT } from "@mycelium/leash-core/paths";
import type { ServiceName } from "./services.ts";
import type { McpServerEntry, McpTransport } from "./mcp-config.ts";

const LEASH_MCP_PORT = Number(process.env["LEASH_MCP_PORT"] ?? 11439);
const LEASH_TOOLS_MCP_PORT = Number(process.env["LEASH_TOOLS_MCP_PORT"] ?? 11440);
const TOOLS_MCP_HEALTH = `http://127.0.0.1:${LEASH_TOOLS_MCP_PORT}/health`;
const OPEN_COMPUTER_USE_BIN = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "open-computer-use.cmd" : "open-computer-use");

/**
 * The tool groups hosted by the ONE `leash-tools-mcp` daemon — each a built-in MCP server
 * the user toggles independently in Brain → MCP. id/label/blurb MIRROR `@mycelium/leash-core`'s
 * `TOOL_GROUPS` (kept as plain data here so the web bundle doesn't pull the daemon's group
 * code + its prisma/provider deps). Add a group → add a row here and in `groups/index.ts`.
 * They SHARE `service: "leash-tools-mcp"`, so the daemon is reference-counted: it starts when
 * the first group turns on and stops when the last turns off (see mcp-lifecycle.ts).
 */
const TOOLS_MCP_GROUPS = BRAIN_MCP_TOOL_GROUPS;

export interface McpBuiltin {
  /** Stable id (also the key under `builtins` in the store). */
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  /** http/sse only. */
  url?: string;
  /** stdio only. */
  command?: string;
  /** stdio only. */
  args?: string[];
  /** stdio only. */
  cwd?: string;
  /** stdio only. */
  env?: Record<string, string>;
  /** The supervised daemon this built-in starts/stops. Absent for self-launching stdio built-ins. */
  service?: ServiceName;
  /** Liveness probe — polled until ready when a daemon-backed built-in is turned on. */
  healthUrl?: string;
  /** Enabled state on a fresh install. The CORE assistant groups (the senses + memory + tasks the
   *  chat and the proactive heartbeat depend on) are ON by default — built-in, the user never starts
   *  them — so the daemon is always up; everything else is opt-in. See ALWAYS_ON_GROUPS below. */
  defaultEnabled: boolean;
}

/**
 * Tool groups ON by a fresh install — the daemon must always be up for the assistant to function:
 * `context` (search_graph + live activity), `files` (read-only local file search), `memory`
 * (remember/recall), `tasks` (create/list), and `feed` (the daily paper). These ARE the proactive
 * heartbeat's propose-only tools plus the built-in file-finder's executor, so a fresh user's
 * heartbeat and local-file skill work out of the box. The heavier / privileged / setup-requiring
 * groups (home-assistant, photos, image, research, computer, mcp-admin, skills) stay opt-in.
 */
const ALWAYS_ON_GROUPS = new Set<string>(BRAIN_ALWAYS_ON_TOOL_GROUPS);

export const MCP_BUILTINS: McpBuiltin[] = [
  {
    id: "builtin:mesh-tools",
    name: "Mesh Tools",
    description: "Pair and manage mesh devices from chat — “pair this device with my laptop” becomes an in-chat flow with the PIN asked as a form.",
    url: `http://127.0.0.1:${LEASH_MCP_PORT}/mcp`,
    transport: "http",
    service: "leash-mcp",
    healthUrl: `http://127.0.0.1:${LEASH_MCP_PORT}/health`,
    defaultEnabled: false,
  },
  {
    id: "builtin:computer-use",
    name: "Computer Use",
    description: "Use Open Computer Use's local stdio MCP server to inspect apps and act on this Mac.",
    transport: "stdio",
    command: OPEN_COMPUTER_USE_BIN,
    args: ["mcp"],
    defaultEnabled: false,
  },
  ...TOOLS_MCP_GROUPS.map((g): McpBuiltin => ({
    id: `builtin:tools-${g.id}`,
    name: g.name,
    description: g.description,
    url: `http://127.0.0.1:${LEASH_TOOLS_MCP_PORT}/mcp/${g.id}`,
    transport: "http",
    service: "leash-tools-mcp",
    healthUrl: TOOLS_MCP_HEALTH,
    defaultEnabled: ALWAYS_ON_GROUPS.has(g.id),
  })),
];

export function builtinById(id: string): McpBuiltin | undefined {
  return MCP_BUILTINS.find((b) => b.id === id);
}

/**
 * Materialize a built-in as a full store entry. Connection (url/transport) is fixed in code;
 * the user may override its display `name` and `userIcon` (persisted under `builtins[id]`).
 */
export function builtinEntry(b: McpBuiltin, enabled: boolean, overrides?: { name?: string; userIcon?: string }): McpServerEntry {
  return {
    id: b.id,
    name: overrides?.name?.trim() || b.name,
    transport: b.transport,
    enabled,
    builtin: true,
    ...(b.url ? { url: b.url } : {}),
    ...(b.command ? { command: b.command } : {}),
    ...(b.args ? { args: b.args } : {}),
    ...(b.cwd ? { cwd: b.cwd } : {}),
    ...(b.env ? { env: b.env } : {}),
    ...(overrides?.userIcon ? { userIcon: overrides.userIcon } : {}),
  };
}
