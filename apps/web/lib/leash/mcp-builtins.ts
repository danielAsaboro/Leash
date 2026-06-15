/**
 * Built-in MCP servers (server-only) — code-defined, non-deletable, lifecycle-bound.
 *
 * A built-in is the bridge between a SUPERVISED DAEMON (a `services.ts` ServiceDef) and
 * the MCP tool layer: flipping it on in Brain → MCP starts the daemon AND connects to
 * it; flipping it off disconnects AND stops the daemon. The user can never delete it —
 * only turn it off. Its connection target (URL/transport) is fixed here; only its
 * enabled bit is persisted (as an override in `data/leash-mcp.json`).
 *
 * Today the sole built-in is "Mesh Tools" — the `leash-mcp` daemon (:11439) that turns
 * device pairing into in-chat tools with the PIN asked as an elicitation form.
 */
import "server-only";
import type { ServiceName } from "./services.ts";
import type { McpServerEntry, McpTransport } from "./mcp-config.ts";

const LEASH_MCP_PORT = Number(process.env["LEASH_MCP_PORT"] ?? 11439);
const LEASH_TOOLS_MCP_PORT = Number(process.env["LEASH_TOOLS_MCP_PORT"] ?? 11440);
const TOOLS_MCP_HEALTH = `http://127.0.0.1:${LEASH_TOOLS_MCP_PORT}/health`;

/**
 * The tool groups hosted by the ONE `leash-tools-mcp` daemon — each a built-in MCP server
 * the user toggles independently in Brain → MCP. id/label/blurb MIRROR `@mycelium/leash-core`'s
 * `TOOL_GROUPS` (kept as plain data here so the web bundle doesn't pull the daemon's group
 * code + its prisma/provider deps). Add a group → add a row here and in `groups/index.ts`.
 * They SHARE `service: "leash-tools-mcp"`, so the daemon is reference-counted: it starts when
 * the first group turns on and stops when the last turns off (see mcp-lifecycle.ts).
 */
const TOOLS_MCP_GROUPS: { id: string; name: string; description: string }[] = [
  { id: "home-assistant", name: "Home Assistant", description: "Control smart-home devices (lights, switches, fans, covers, scenes) over Home Assistant's LAN API." },
  { id: "feed", name: "Feed", description: "Search the user's auto-written on-device daily paper (The Understory)." },
  { id: "memory", name: "Memory", description: "Save and recall typed memories about the user (preferences, facts, goals, people, routines)." },
  { id: "tasks", name: "Tasks", description: "Create, list, and update tasks on the user's to-do list." },
  { id: "context", name: "Context", description: "Search the user's private context graph (notes, files, memories, past chats) and read their live screen activity." },
  { id: "photos", name: "Photos", description: "List the user's images and their on-device auto-tags." },
  { id: "image", name: "Image", description: "Generate images from text, fully on-device." },
  { id: "research", name: "Research", description: "Run a deep, multi-source WEB research run in the background (needs network)." },
  { id: "skills", name: "Skills", description: "Load the user's skills on demand and run their bundled scripts (read_skill, read_skill_file, run_skill_script)." },
  { id: "computer", name: "Computer Use", description: "See and act on this Mac: screenshot, approval-gated run_command (the real-disk executor), and mouse/keyboard." },
  { id: "files", name: "Files", description: "Sandboxed read-only file retrieval (grep/find/cat/jq) over a snapshot of the user's files." },
  { id: "mcp-admin", name: "MCP", description: "Install and register OTHER MCP servers from a URL or by hand (install_mcp_repo, upsert_mcp_server)." },
  { id: "scheduler", name: "Scheduler", description: "Let the assistant schedule its own future actions — recurring reminders and allowlisted maintenance jobs (no arbitrary commands, no cloud AI tasks)." },
];

export interface McpBuiltin {
  /** Stable id (also the key under `builtins` in the store). */
  id: string;
  name: string;
  description: string;
  url: string;
  transport: McpTransport;
  /** The supervised daemon this built-in starts/stops. */
  service: ServiceName;
  /** Liveness probe — polled until ready when the built-in is turned on. */
  healthUrl: string;
  /** Enabled state on a fresh install. The CORE assistant groups (the senses + memory + tasks the
   *  chat and the proactive heartbeat depend on) are ON by default — built-in, the user never starts
   *  them — so the daemon is always up; everything else is opt-in. See ALWAYS_ON_GROUPS below. */
  defaultEnabled: boolean;
}

/**
 * Tool groups ON by a fresh install — the daemon must always be up for the assistant to function:
 * `context` (search_graph + live activity), `memory` (remember/recall), `tasks` (create/list), and
 * `feed` (the daily paper). These ARE the proactive heartbeat's propose-only tools, so a fresh user's
 * heartbeat works out of the box. The heavier / privileged / setup-requiring groups (home-assistant,
 * photos, image, research, computer, files, mcp-admin, skills) stay opt-in.
 */
const ALWAYS_ON_GROUPS = new Set(["context", "memory", "tasks", "feed"]);

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
    url: b.url,
    enabled,
    builtin: true,
    ...(overrides?.userIcon ? { userIcon: overrides.userIcon } : {}),
  };
}
