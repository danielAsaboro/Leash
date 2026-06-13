/**
 * Re-export shim — the private context graph (`search_graph` retrieval) moved to
 * `@mycelium/leash-core` (shared with the `leash-tools-mcp` Context group). Web consumers
 * (council, Memory tab) keep importing `from "./graph.ts"`. The package uses its own
 * minimal embedding provider (`provider-core`), so web's full `provider.ts` is untouched.
 */
import "server-only";
export * from "@mycelium/leash-core/graph";
