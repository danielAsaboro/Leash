/**
 * Re-export shim — the agents store (plugin sub-agent parsing + `listAgents`) lives in
 * `@mycelium/leash-core`. `server-only` keeps the client-import guard here. Web imports stay
 * `from "./agents-store.ts"`.
 */
import "server-only";
export * from "@mycelium/leash-core/agents-store";
