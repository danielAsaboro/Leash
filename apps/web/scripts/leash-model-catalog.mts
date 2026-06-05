/**
 * Dump the `@qvac/sdk` model catalog to `data/leash-models-catalog.json`.
 *
 *   npx tsx apps/web/scripts/leash-model-catalog.mts
 *
 * Runs as a SPAWNED CHILD of the web app (or by hand): the Next process is
 * deliberately HTTP-only and never imports the native SDK — this script is where
 * the SDK lives. Walks every SDK export and keeps the `ModelConstant`-shaped ones
 * (same `src`/`name`/`addon` shape test as @qvac/cli's sdk-constants.js), recording
 * what the models inventory needs:
 *   · name / addon / engine / params / quantization / expectedSize
 *   · registryPath + the derived CACHE FILENAME — sha256(registryPath).hex[0:16]
 *     + "_" + basename(registryPath) — verified against ~/.qvac/models (this also
 *     disambiguates same-basename collisions like the two Qwen3-4B-Q4_K_M.gguf).
 */
import { createHash } from "node:crypto";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — SDK model constants are runtime exports absent from the .d.ts surface
import * as sdk from "@qvac/sdk";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/scripts → repo root → data/. */
const OUT = process.env["LEASH_MODELS_CATALOG"] ?? join(here, "..", "..", "..", "data", "leash-models-catalog.json");

interface ModelConstant {
  name: string;
  src: string;
  registryPath?: string;
  modelId?: string;
  addon: string;
  engine?: string;
  params?: string;
  quantization?: string;
  expectedSize?: number;
}

function isModelConstant(v: unknown): v is ModelConstant {
  return v !== null && typeof v === "object" && "src" in v && "name" in v && "addon" in v;
}

/** The SDK's on-disk cache filename for a registry asset. */
function cacheFile(registryPath: string): string {
  return `${createHash("sha256").update(registryPath).digest("hex").slice(0, 16)}_${basename(registryPath)}`;
}

const entries = Object.values(sdk as Record<string, unknown>)
  .filter(isModelConstant)
  .map((m) => ({
    name: m.name,
    addon: m.addon,
    ...(m.engine ? { engine: m.engine } : {}),
    ...(m.params ? { params: m.params } : {}),
    ...(m.quantization ? { quantization: m.quantization } : {}),
    ...(typeof m.expectedSize === "number" ? { expectedSize: m.expectedSize } : {}),
    ...(m.registryPath ? { registryPath: m.registryPath, cacheFile: cacheFile(m.registryPath) } : {}),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(dirname(OUT), { recursive: true });
const tmp = join(dirname(OUT), `.catalog-${Date.now()}.tmp`);
writeFileSync(tmp, JSON.stringify({ generatedAt: Date.now(), sdk: "@qvac/sdk", models: entries }, null, 2));
renameSync(tmp, OUT);
console.log(`📚 wrote ${entries.length} model constants → ${OUT}`);
