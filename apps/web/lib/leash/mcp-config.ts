/**
 * Re-export shim — MCP server config validation/parsing moved to `@mycelium/leash-core`
 * (shared with the `leash-tools-mcp` MCP-admin group). ISOMORPHIC (no `server-only`): it
 * runs in the browser too (the add-server modal). Web imports stay `from "./mcp-config.ts"`.
 */
export * from "@mycelium/leash-core/mcp-config";
