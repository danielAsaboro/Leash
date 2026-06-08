/**
 * The one adapter resolver: newest promotable adapter on disk.
 *
 * "Promotable" = its manifest's `evalDelta >= minDelta` (default 0): the adapter
 * scored at least as well as its base on the frozen eval. A regression never reaches
 * the live chat. Reads only plain `manifest.json` files (no corestore — fd-lock safe).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { AdapterManifest } from "./types.ts";
import { ADAPTERS_DIR, adapterGguf, adapterManifest } from "./paths.ts";

export interface ResolvedAdapter {
  version: string;
  ggufPath: string;
  manifest: AdapterManifest;
}

export interface ApplyOptions {
  /** Minimum evalDelta to promote (default 0 — adapter must not regress). */
  minDelta?: number;
}

/** All version dirs that have BOTH a manifest.json and the adapter.gguf, newest first. */
function manifests(): ResolvedAdapter[] {
  if (!existsSync(ADAPTERS_DIR)) return [];
  const out: ResolvedAdapter[] = [];
  for (const version of readdirSync(ADAPTERS_DIR)) {
    const dir = adapterManifest(version);
    const gguf = adapterGguf(version);
    if (!existsSync(dir) || !existsSync(gguf)) continue;
    try {
      if (!statSync(gguf).isFile()) continue;
      const manifest = JSON.parse(readFileSync(dir, "utf-8")) as AdapterManifest;
      out.push({ version, ggufPath: gguf, manifest });
    } catch {
      // skip a corrupt manifest
    }
  }
  // version stamps are lexicographically chronological → newest last; sort desc.
  return out.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
}

/** Newest adapter whose evalDelta clears the bar, or undefined. */
export function latestAdapter(opts: ApplyOptions = {}): ResolvedAdapter | undefined {
  const minDelta = opts.minDelta ?? 0;
  return manifests().find((m) => m.manifest.evalDelta >= minDelta);
}

/** Just the gguf path of the newest promotable adapter (for modelConfig.lora / serve). */
export function latestAdapterPath(opts: ApplyOptions = {}): string | undefined {
  return latestAdapter(opts)?.ggufPath;
}

/** The newest manifest of ANY adapter (promotable or not) — for the growth chart. */
export function latestManifest(): AdapterManifest | undefined {
  return manifests()[0]?.manifest;
}
