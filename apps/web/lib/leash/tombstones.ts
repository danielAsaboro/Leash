/**
 * Re-export shim — activity tombstones moved to `@mycelium/leash-core` (shared with the
 * `leash-tools-mcp` Context group; now cross-process-locked). Web imports stay unchanged.
 */
import "server-only";
export * from "@mycelium/leash-core/tombstones";
