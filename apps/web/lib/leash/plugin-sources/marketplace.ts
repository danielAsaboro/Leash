/**
 * Marketplace plugin source (server-only) — a Claude-Code-compatible `marketplace.json` index whose
 * entries each resolve to a `github` or `mesh` source.
 *
 * Adding a marketplace fetches + CACHES its index to `data/leash-marketplaces/<id>.json`, so browsing
 * works offline after the first fetch (the warm-cache pattern). Installing an entry resolves its
 * source ref → the same staging path the direct sources use → `installStagedPlugin` (always disabled).
 */
import "server-only";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../json-store.ts";
import { MARKETPLACES_DIR } from "../plugins-store.ts";
import { slugify } from "../skills-store.ts";
import { parseMarketplaceJson, type Marketplace, type PluginSourceRef } from "../plugin-manifest.ts";
import { stageFromGitHub } from "./github.ts";
import { stageFromMesh } from "./mesh.ts";
import type { StagedPlugin } from "./stage.ts";

/** A cached marketplace: the parsed index plus where + when it came from. */
export interface CachedMarketplace {
  id: string;
  url: string;
  fetchedAt: number;
  marketplace: Marketplace;
}

function cacheFile(id: string): string {
  return join(MARKETPLACES_DIR, `${id}.json`);
}

/** Fetch a marketplace index from `url`, parse it, and cache it under its id (slug of its name). */
export async function addMarketplace(url: string): Promise<CachedMarketplace> {
  const u = url.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) throw new Error("marketplace URL must start with http:// or https://");
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "follow" });
  } catch (err) {
    throw new Error(`couldn't fetch the marketplace: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`the marketplace URL returned ${res.status}`);
  const marketplace = parseMarketplaceJson(await res.text());
  const id = slugify(marketplace.name);
  if (!id) throw new Error(`the marketplace name "${marketplace.name}" doesn't make a valid id`);
  const cached: CachedMarketplace = { id, url: u, fetchedAt: Date.now(), marketplace };
  await mkdir(MARKETPLACES_DIR, { recursive: true });
  await writeJson(cacheFile(id), cached);
  return cached;
}

/** Every cached marketplace (offline browse). `[]` when none added yet. */
export async function listMarketplaces(): Promise<CachedMarketplace[]> {
  let files: string[];
  try {
    files = await readdir(MARKETPLACES_DIR);
  } catch {
    return [];
  }
  const out: CachedMarketplace[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(MARKETPLACES_DIR, f), "utf8")) as CachedMarketplace);
    } catch {
      /* skip a corrupt cache file */
    }
  }
  return out.sort((a, b) => a.marketplace.name.localeCompare(b.marketplace.name));
}

/** Resolve a source ref (from a marketplace entry) into a staged plugin tree. */
export async function stageFromRef(ref: PluginSourceRef): Promise<StagedPlugin> {
  if (ref.kind === "github") return stageFromGitHub(ref.ref);
  if (ref.kind === "mesh") return stageFromMesh(ref.ref);
  throw new Error(`marketplace entries can only resolve github or mesh sources (got "${ref.kind}")`);
}

/** Stage a named entry from a cached marketplace. */
export async function stageFromMarketplace(marketplaceId: string, entryName: string): Promise<{ staged: StagedPlugin; source: PluginSourceRef }> {
  const cached = (await listMarketplaces()).find((m) => m.id === marketplaceId);
  if (!cached) throw new Error(`no cached marketplace "${marketplaceId}" — add it first`);
  const entry = cached.marketplace.entries.find((e) => e.name === entryName);
  if (!entry) throw new Error(`no plugin "${entryName}" in marketplace "${marketplaceId}"`);
  return { staged: await stageFromRef(entry.source), source: entry.source };
}
