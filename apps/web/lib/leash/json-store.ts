/**
 * Re-export shim — the implementation moved to `@mycelium/leash-core` so the
 * `leash-tools-mcp` daemon shares ONE store with the web process. Web imports stay
 * `from "./json-store.ts"`; `server-only` keeps the client-import guard on this side.
 */
import "server-only";
export * from "@mycelium/leash-core/json-store";
