/**
 * Re-export shim — the plugin registry + install choke-point + virtual surfacers live in
 * `@mycelium/leash-core` (shared with the daemon's component reads). `server-only` keeps the
 * client-import guard here. Web imports stay `from "./plugins-store.ts"`.
 */
import "server-only";
export * from "@mycelium/leash-core/plugins-store";
