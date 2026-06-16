/**
 * Read-only view of Leash's installed-plugin registry, for mesh distribution.
 *
 * Hypha and Leash share ONE on-disk store: `data/leash-plugins.json` (the registry rows) + the
 * extracted trees under `data/leash-plugins/<id>/`. Leash-core's own `plugins-store.ts` is the
 * writer and the single install choke-point, but it is `import "server-only"` (only resolvable
 * inside the Next build) — so this daemon, a plain Node/tsx process, reads the SAME files directly
 * with the SAME path-resolution + env overrides (`LEASH_DATA_DIR`, `LEASH_PLUGINS_DIR`,
 * `LEASH_PLUGINS_FILE`) rather than importing that module. No fork of behavior: we only READ the
 * row + zip the tree; installs still go through Leash.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

/** `data/leash-plugins/<id>/` — the extracted plugin trees (same default + env as leash-core). */
export const PLUGINS_DIR = process.env["LEASH_PLUGINS_DIR"] ?? join(process.env["LEASH_DATA_DIR"] ?? DATA_DIR, "leash-plugins");
/** `data/leash-plugins.json` — the persisted registry (same default + env as leash-core). */
export const PLUGINS_FILE = process.env["LEASH_PLUGINS_FILE"] ?? join(process.env["LEASH_DATA_DIR"] ?? DATA_DIR, "leash-plugins.json");

/** One registered plugin — the persisted row in `leash-plugins.json` (the subset we read). */
export interface PluginEntry {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
}

function sane(e: unknown): e is PluginEntry {
  const p = e as PluginEntry;
  return !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.enabled === "boolean";
}

/** Every registered plugin (install order). Returns [] when the registry doesn't exist yet. */
export function listPlugins(): PluginEntry[] {
  let raw: string;
  try {
    raw = readFileSync(PLUGINS_FILE, "utf8");
  } catch {
    return []; // no registry on this device yet
  }
  let cfg: { plugins?: unknown };
  try {
    cfg = JSON.parse(raw) as { plugins?: unknown };
  } catch {
    return [];
  }
  return Array.isArray(cfg.plugins) ? cfg.plugins.filter(sane) : [];
}

/** One plugin by id, or null. */
export function getPlugin(id: string): PluginEntry | null {
  return listPlugins().find((p) => p.id === id) ?? null;
}
