/**
 * Re-export shim — the plugin tree loader lives in `@mycelium/leash-core`. `server-only` keeps the
 * client-import guard here. Web imports stay `from "./plugin-loader.ts"`.
 */
import "server-only";
export * from "@mycelium/leash-core/plugin-loader";
