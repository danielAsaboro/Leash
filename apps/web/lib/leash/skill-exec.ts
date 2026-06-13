/**
 * Re-export shim — skill script execution moved to `@mycelium/leash-core` (shared with the
 * `leash-tools-mcp` Skills group's `run_skill_script`). Web imports stay unchanged.
 */
import "server-only";
export * from "@mycelium/leash-core/skill-exec";
