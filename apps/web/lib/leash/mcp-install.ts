/**
 * Re-export shim — the compound MCP-install pipeline moved to `@mycelium/leash-core`
 * (shared with the `leash-tools-mcp` MCP-admin group's `install_mcp_repo`; also gives
 * `mcp.ts` its `MCP_REPOS_DIR`). Web imports stay `from "./mcp-install.ts"`.
 */
import "server-only";
export * from "@mycelium/leash-core/mcp-install";
