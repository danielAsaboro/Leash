/**
 * Dump the QVAC model catalog to `data/leash-models-catalog.json`.
 *
 *   npx tsx apps/web/scripts/leash-model-catalog.mts
 *
 * Source: `@qvac/ai-sdk-provider`'s `allModels` — the AUTHORITATIVE catalog (729+
 * models), which carries a clean `endpointCategory` (chat/embedding/transcription/
 * speech/image/ocr/translation) per model. That's far better than walking the raw
 * `@qvac/sdk` exports and guessing the use-case by name. Runs as a SPAWNED CHILD (the
 * Next process stays HTTP-only and never imports the SDK/provider model graph here).
 *
 * We record what the inventory + Forage need:
 *   · name / endpointCategory / addon / engine / params / quantization / expectedSize
 *   · registryPath + the derived CACHE FILENAME — sha256(registryPath).hex[0:16] + "_" +
 *     basename(registryPath) — verified against the scoped `data/models` cache (disambiguates the
 *     same-basename collisions like the two Qwen3-4B-Q4_K_M.gguf).
 */
import { createHash } from "node:crypto";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { allModels } from "@qvac/ai-sdk-provider";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/scripts → repo root → data/. */
const OUT = process.env["LEASH_MODELS_CATALOG"] ?? join(here, "..", "..", "..", "data", "leash-models-catalog.json");

/** The SDK's on-disk cache filename for a registry asset. */
function cacheFile(registryPath: string): string {
  return `${createHash("sha256").update(registryPath).digest("hex").slice(0, 16)}_${basename(registryPath)}`;
}

interface ProviderModel {
  name: string;
  endpointCategory?: string;
  addon?: string;
  engine?: string;
  params?: string;
  quantization?: string;
  expectedSize?: number;
  registryPath?: string;
}

const entries = (allModels as ProviderModel[])
  .filter((m) => m && typeof m.name === "string")
  .map((m) => ({
    name: m.name,
    ...(m.endpointCategory ? { endpointCategory: m.endpointCategory } : {}),
    ...(m.addon ? { addon: m.addon } : {}),
    ...(m.engine ? { engine: m.engine } : {}),
    ...(m.params ? { params: m.params } : {}),
    ...(m.quantization ? { quantization: m.quantization } : {}),
    ...(typeof m.expectedSize === "number" ? { expectedSize: m.expectedSize } : {}),
    ...(m.registryPath ? { registryPath: m.registryPath, cacheFile: cacheFile(m.registryPath) } : {}),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(dirname(OUT), { recursive: true });
const tmp = join(dirname(OUT), `.catalog-${Date.now()}.tmp`);
writeFileSync(tmp, JSON.stringify({ generatedAt: Date.now(), source: "@qvac/ai-sdk-provider", models: entries }, null, 2));
renameSync(tmp, OUT);
console.log(`📚 wrote ${entries.length} models (with endpointCategory) → ${OUT}`);
