/**
 * Re-export shim — the secret vault moved to `@mycelium/leash-core` (shared with the
 * `leash-tools-mcp` Home-Assistant group). NOT `server-only`: imported by Next routes AND
 * the research tsx child (which reads the SearXNG URL).
 */
export * from "@mycelium/leash-core/vault";
