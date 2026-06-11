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
  /** Enabled state on a fresh install (OFF — turning it on is the explicit opt-in that spawns the daemon). */
  defaultEnabled: boolean;
}

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
