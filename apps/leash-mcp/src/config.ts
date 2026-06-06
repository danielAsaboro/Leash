/** Leash MCP server config — ports + the hypha control-plane URL it drives. */

/** Where this MCP server listens (localhost only — the dashboard is its only client). */
export const LEASH_MCP_PORT = Number(process.env["LEASH_MCP_PORT"] ?? 11439);

/** Hypha's localhost control plane (pairing routes + health). */
export const HYPHA_URL = (process.env["LEASH_MCP_HYPHA_URL"] ?? `http://127.0.0.1:${Number(process.env["HYPHA_PORT"] ?? 11437)}`).replace(/\/+$/, "");
