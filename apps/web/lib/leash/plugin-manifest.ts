/**
 * Re-export shim — plugin/marketplace manifest parsing lives in `@mycelium/leash-core`.
 * ISOMORPHIC (no `server-only`): the dashboard's install-preview runs the same parse in the
 * browser. Web imports stay `from "./plugin-manifest.ts"`.
 */
export * from "@mycelium/leash-core/plugin-manifest";
