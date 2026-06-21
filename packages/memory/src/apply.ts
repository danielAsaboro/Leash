/**
 * The one adapter resolver: newest promotable adapter on disk.
 *
 * "Promotable" = a meaningful overall held-out gain with no material per-axis
 * regression. Reads only plain `manifest.json` files (no corestore — fd-lock safe).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { AdapterManifest } from "./types.ts";
import { ADAPTERS_DIR, adapterGguf, adapterManifest } from "./paths.ts";
import { evaluateAdapterQuality } from "./adapter-quality.ts";

export interface ResolvedAdapter {
  version: string;
  ggufPath: string;
  manifest: AdapterManifest;
}

export interface ApplyOptions {
  /** Minimum held-out improvement required for promotion (default 0.02). */
  minDelta?: number;
  /** Largest tolerated regression on any evaluation axis (default 0.02). */
  maxAxisRegression?: number;
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
  return manifests().find((candidate) => evaluateAdapterQuality(candidate.manifest, opts).passed);
}

/** Just the gguf path of the newest promotable adapter (for modelConfig.lora / serve). */
export function latestAdapterPath(opts: ApplyOptions = {}): string | undefined {
  return latestAdapter(opts)?.ggufPath;
}

/** The newest manifest of ANY adapter (promotable or not) — for the growth chart. */
export function latestManifest(): AdapterManifest | undefined {
  return manifests()[0]?.manifest;
}
