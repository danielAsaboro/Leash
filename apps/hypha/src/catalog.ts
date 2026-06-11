/**
 * Alias → modelSrc resolution.
 *
 * A device advertises serve ALIASES (from `qvac.config.base.json`), but a peer delegates by
 * `modelSrc`. We resolve each alias's registry `model` name against the cached
 * `data/leash-models-catalog.json` (the `@qvac/ai-sdk-provider` allModels dump) into a
 * delegable id, and can rebuild a full SDK descriptor from that id on the consumer side.
 *
 * EVERY served alias is advertised, tagged with its modality (chat / vision / embedding / stt /
 * tts) and whether it's BORROWABLE. Per the Phase-0 gate (spike/07-p2p-multimodal.ts), the SDK
 * delegates `completion()` only, so chat + vision are borrowable and embeddings/STT/TTS are
 * advertised display-only ("shared · local-only"). Custom-GGUF completion aliases (a config `.src`
 * path, e.g. medpsy) are advertised but only delegable to a peer holding the same local file.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as qvac from "@qvac/sdk";
import { CATALOG_FILE, QVAC_CONFIG_FILE } from "./config.ts";
import { modelType, isBorrowable, type Modality } from "./model-type.ts";

/** Expand a machine-neutral `~/` config path to THIS machine's home dir. */
const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

interface CatalogEntry {
  name: string;
  endpointCategory?: string;
  addon?: string;
  engine?: string;
  registryPath?: string;
  cacheFile?: string;
  expectedSize?: number;
}
interface ServeModelEntry {
  model?: string;
  src?: string;
  type?: string;
  config?: Record<string, unknown>;
}

/** A serve alias paired with the delegable modelSrc id (registryPath, or a custom path), its
 * modality, and whether it can be borrowed over the mesh (chat + vision — Phase-0 gate). */
export interface AliasModel {
  alias: string;
  modelSrc: string;
  modelType: Modality;
  borrowable: boolean;
  /** Vision only — the advertiser's OWN absolute projection (mmproj) path. The SDK requires an
   * absolute path and uses it verbatim on the provider; the content-hash filename is identical on
   * every Mac, so the provider resolves its own copy (same pattern as a custom `.src`). */
  projectionModelSrc?: string;
}

/** A full SDK model descriptor (the rich form `loadModel` accepts). */
export interface ModelDescriptor {
  src: string;
  name?: string;
  registryPath?: string;
  engine?: string;
  expectedSize?: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function catalogByName(): Map<string, CatalogEntry> {
  const cat = readJson<{ models?: CatalogEntry[] }>(CATALOG_FILE, {});
  const m = new Map<string, CatalogEntry>();
  for (const e of cat.models ?? []) if (e?.name) m.set(e.name, e);
  return m;
}

/**
 * Read EVERY served alias from `qvac.config.base.json`, each classified by modality and resolved to a
 * modelSrc id (registryPath for registry models, the absolute `.src` path for custom-GGUF). Borrowable
 * aliases (chat + vision) are what peers can delegate; the rest are advertised display-only.
 */
export function localAliases(): AliasModel[] {
  const cfg = readJson<{ serve?: { models?: Record<string, ServeModelEntry> } }>(QVAC_CONFIG_FILE, {});
  const cat = catalogByName();
  const out: AliasModel[] = [];
  for (const [alias, entry] of Object.entries(cfg.serve?.models ?? {})) {
    const name = entry.model;
    const catEntry = name ? cat.get(name) : undefined;
    const mt = modelType(entry, catEntry);
    if (!mt) continue; // unclassifiable → not advertised
    let modelSrc: string | undefined;
    if (entry.src) {
      // The gossiped modelSrc must be THIS machine's absolute path (the advertiser's own provider
      // loads it on a delegated request) — expand the config's `~/` prefix.
      const src = expandHome(entry.src);
      // Advertise honestly: a filesystem `src` that doesn't exist HERE would register the delegated
      // load and then die silently at decode, poisoning peers' warm pools.
      if (!existsSync(src)) {
        console.warn(`hypha: not advertising alias "${alias}" — src missing on this machine: ${src}`);
        continue;
      }
      modelSrc = src;
    } else if (catEntry?.registryPath) modelSrc = catEntry.registryPath;
    else if (name) modelSrc = name; // catalog miss → the registry constant name (descriptorFor resolves it)
    if (!modelSrc) continue;
    // Vision: resolve the projection (mmproj) to THIS machine's absolute path. Missing locally →
    // don't advertise it borrowable (a delegated vision load would fail on the provider).
    let projectionModelSrc: string | undefined;
    const rawProj = entry.config && typeof entry.config["projectionModelSrc"] === "string" ? (entry.config["projectionModelSrc"] as string) : undefined;
    if (rawProj) {
      const abs = expandHome(rawProj);
      if (!existsSync(abs)) {
        console.warn(`hypha: not advertising vision alias "${alias}" — projection model missing on this machine: ${abs}`);
        continue;
      }
      projectionModelSrc = abs;
    }
    out.push({ alias, modelSrc, modelType: mt, borrowable: isBorrowable(mt), ...(projectionModelSrc ? { projectionModelSrc } : {}) });
  }
  return out;
}

/** Just the borrowable aliases (chat + vision) — for warming and routing delegated requests. */
export function localBorrowableAliases(): AliasModel[] {
  return localAliases().filter((a) => a.borrowable);
}

/**
 * The SDK's exported registry descriptor for a constant name (e.g. `QWEN3_4B_INST_Q4_K_M`), or
 * undefined if the name isn't an exported registry model. The constant carries the REAL
 * `src: "registry://<source>/<registryPath>"` URI + blob metadata the SDK needs to resolve the
 * model from the registry corestore — which the cached catalog's bare `registryPath` lacks.
 */
function sdkRegistryDescriptor(name: string): ModelDescriptor | undefined {
  const c = (qvac as Record<string, unknown>)[name];
  if (c && typeof c === "object" && typeof (c as { src?: unknown }).src === "string") return c as ModelDescriptor;
  return undefined;
}

/**
 * Build the rich SDK descriptor for a gossiped modelSrc id (a registryPath, or a custom path).
 *
 * For a REGISTRY model the gossiped id is the catalog `registryPath` (a bare
 * `qvac_models_compiled/…` path) — which is NOT directly loadable: `loadModel` would treat it as a
 * local file and fail ("Failed to locate model file", found live 2026-06-10). The loadable form is
 * the SDK's exported constant descriptor, whose `src` is the `registry://<source>/…` URI. So we map
 * registryPath → catalog `name` → the SDK constant. A custom `.src` path (e.g. medpsy) is already a
 * real local file, so it passes through as the bare string.
 */
export function descriptorFor(modelSrc: string): ModelDescriptor | string {
  // Direct: the id is itself an exported registry constant name.
  const direct = sdkRegistryDescriptor(modelSrc);
  if (direct) return direct;
  // Registry model gossiped by registryPath → resolve via the catalog's `name` to the SDK constant.
  for (const e of catalogByName().values()) {
    if (e.registryPath === modelSrc && e.name) {
      const d = sdkRegistryDescriptor(e.name);
      if (d) return d;
    }
  }
  // Custom-GGUF path (real local file) or an unknown id → the bare string is a valid modelSrc.
  return modelSrc;
}
