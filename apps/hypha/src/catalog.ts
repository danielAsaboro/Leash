/**
 * Alias → modelSrc resolution.
 *
 * A device advertises serve ALIASES (from `qvac.config.base.json`), but a peer delegates by
 * `modelSrc`. We resolve each alias's registry `model` name against the cached
 * `data/leash-models-catalog.json` (the `@qvac/ai-sdk-provider` allModels dump) into a
 * delegable id, and can rebuild a full SDK descriptor from that id on the consumer side.
 *
 * Only CHAT-completable aliases are advertised — the overflow shim speaks
 * `/v1/chat/completions`, so embeddings (gte-large), STT (parakeet), TTS (supertonic),
 * and multimodal (qwen3vl) aliases are excluded. Custom-GGUF completion aliases (a config
 * `.src` path, e.g. medpsy) are advertised but only delegable to a peer holding the same
 * local file.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CATALOG_FILE, QVAC_CONFIG_FILE } from "./config.ts";

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

/** A serve alias paired with the delegable modelSrc id (registryPath, or a custom path). */
export interface AliasModel {
  alias: string;
  modelSrc: string;
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

/** Is this serve entry a chat/completion LLM (vs embeddings/asr/tts/multimodal)? */
function isChatLlm(entry: ServeModelEntry, cat?: CatalogEntry): boolean {
  // Multimodal (a VLM with a projection model, e.g. qwen3vl) is excluded — the shim does
  // text chat only and can't pass images over the delegated `completion()` path.
  if (entry.config && "projectionModelSrc" in entry.config) return false;
  // Custom-GGUF completion model (e.g. medpsy: type "llamacpp-completion", a `.src` path).
  if (entry.src && (entry.type ?? "").includes("completion")) return true;
  if (!cat) return false;
  return cat.endpointCategory === "chat" && (cat.addon === "llm" || cat.engine?.startsWith("llamacpp") === true);
}

/**
 * Read THIS device's chat-completable aliases from `qvac.config.base.json`, each resolved to a
 * delegable modelSrc id. Custom-GGUF aliases keep their absolute `.src` path.
 */
export function localChatAliases(): AliasModel[] {
  const cfg = readJson<{ serve?: { models?: Record<string, ServeModelEntry> } }>(QVAC_CONFIG_FILE, {});
  const cat = catalogByName();
  const out: AliasModel[] = [];
  for (const [alias, entry] of Object.entries(cfg.serve?.models ?? {})) {
    const name = entry.model;
    const catEntry = name ? cat.get(name) : undefined;
    if (!isChatLlm(entry, catEntry)) continue;
    if (entry.src) {
      // The gossiped modelSrc must be THIS machine's absolute path (the advertiser's own
      // provider loads it on a delegated request) — expand the config's `~/` prefix.
      const src = expandHome(entry.src);
      // Advertise honestly: a filesystem `src` that doesn't exist HERE would register the
      // delegated load and then die silently at decode, poisoning peers' warm pools.
      if (!existsSync(src)) {
        console.warn(`hypha: not advertising alias "${alias}" — src missing on this machine: ${src}`);
        continue;
      }
      out.push({ alias, modelSrc: src });
    } else if (catEntry?.registryPath) out.push({ alias, modelSrc: catEntry.registryPath });
    // A registry-name model absent from the catalog is skipped (can't resolve a modelSrc).
  }
  return out;
}

/**
 * Build the rich SDK descriptor for a gossiped modelSrc id (a registryPath, or a custom
 * path). Matches the local catalog by registryPath to recover name/engine/size; falls
 * back to the bare string (still a valid modelSrc) for a custom path or a catalog miss.
 */
export function descriptorFor(modelSrc: string): ModelDescriptor | string {
  for (const e of catalogByName().values()) {
    if (e.registryPath === modelSrc) {
      return {
        src: e.registryPath,
        ...(e.name ? { name: e.name } : {}),
        registryPath: e.registryPath,
        ...(e.engine ? { engine: e.engine } : {}),
        ...(e.expectedSize ? { expectedSize: e.expectedSize } : {}),
      };
    }
  }
  return modelSrc;
}
