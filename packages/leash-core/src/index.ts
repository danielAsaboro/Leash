/**
 * @mycelium/leash-core — the shared backing layer for Leash tools, used by BOTH the Next web
 * process and the standalone `leash-tools-mcp` daemon. The web's `apps/web/lib/leash/*`
 * modules for these stores are now thin re-export shims over this package, so there is ONE
 * implementation (with cross-process file locks where two writers contend).
 *
 * Subpath exports (`@mycelium/leash-core/json-store`, `/vault`, `/graph`, `/groups`, …) let
 * the shims re-export module-for-module; this barrel is the convenience surface. Path
 * constants are exported once here (others re-export them via subpaths to stay drop-in).
 */
export { REPO_ROOT, GEN_DIR, PHOTO_TAGS } from "./paths.ts";
export * from "./sources.ts";
export * from "./lock.ts";
export * from "./json-store.ts"; // DATA_DIR + readJson/writeJson/readJsonCached/invalidateJsonCache
export * from "./vault.ts";
export * from "./tombstones.ts";
export * from "./memories-store.ts";
export * from "./tasks-store.ts";
export * from "./provider-core.ts";
export * from "./graph.ts"; // searchNotes/readActivityRecords/… + NOTES_DIR/ACTIVITY_LOG/CHATS_DIR
export { TOOL_GROUPS, groupById, approvalToolNames } from "./groups/index.ts";
export type { ToolGroup, GroupTool } from "./groups/types.ts";
