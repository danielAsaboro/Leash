/**
 * Re-export shim — the skills store moved to `@mycelium/leash-core` (shared with the
 * `leash-tools-mcp` Skills group). Web routing (skill activation, the dashboard) keeps
 * importing `from "./skills-store.ts"`; `server-only` keeps the client-import guard here.
 */
import "server-only";
export * from "@mycelium/leash-core/skills-store";
