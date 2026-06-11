/**
 * Pure-logic smoke for the Models-tab browser core (apps/web/lib/leash/model-rows.ts).
 * This is the isomorphic logic behind the unified, filterable model list: the `addon → kind`
 * classifier, the merge of configured + on-disk + catalog-residual rows (no double-counting),
 * and the per-row state classifier that drives the State icon. Proves the merge tags categories
 * correctly, produces sparse `available` rows, and that `modelState` covers every branch.
 *
 *   npm run smoke:model-rows
 */
import assert from "node:assert/strict";
import type { InventoryRow, CatalogModel, ModelsInventory } from "../apps/web/lib/leash/models.ts";
import { kindOf, buildModelRows, modelState, type ModelCategory, type TaggedRow } from "../apps/web/lib/leash/model-rows.ts";

// ── kindOf: every catalog addon maps to a kind; unknown/none → "other" ─────────────
assert.equal(kindOf("llm"), "text", "llm → text");
assert.equal(kindOf("diffusion"), "image", "diffusion → image");
assert.equal(kindOf("embeddings"), "embedding", "embeddings → embedding");
assert.equal(kindOf("parakeet"), "speech", "parakeet → speech");
assert.equal(kindOf("whisper"), "speech", "whisper → speech");
assert.equal(kindOf("tts"), "speech", "tts → speech");
assert.equal(kindOf("nmt"), "translation", "nmt → translation");
assert.equal(kindOf("ocr"), "ocr", "ocr → ocr");
assert.equal(kindOf(null), "other", "null addon → other");
assert.equal(kindOf(undefined), "other", "missing addon → other");
assert.equal(kindOf("totally-unknown"), "other", "unknown addon → other");

// ── buildModelRows: merge without double-counting ──────────────────────────────────
function invRow(p: Partial<InventoryRow> & { name: string }): InventoryRow {
  return {
    name: p.name,
    alias: p.alias ?? null,
    addon: p.addon ?? null,
    engine: p.engine ?? null,
    params: p.params ?? null,
    quantization: p.quantization ?? null,
    ctxSize: p.ctxSize ?? null,
    useGpu: p.useGpu ?? null,
    tokPerSec: p.tokPerSec ?? null,
    fit: p.fit ?? { gb: 0, verdict: null, deviceGB: 0 },
    expectedSize: p.expectedSize ?? null,
    cacheFile: p.cacheFile ?? null,
    onDiskBytes: p.onDiskBytes ?? null,
    inConfig: p.inConfig ?? false,
    preload: p.preload ?? false,
    isDefault: p.isDefault ?? false,
    loaded: p.loaded ?? false,
  };
}

const inv: ModelsInventory = {
  serve: { up: true, ready: ["qwen"] },
  configured: [
    invRow({ name: "QWEN3_4B", alias: "qwen", addon: "llm", engine: "llamacpp-completion", params: "4B", quantization: "q4_k_m", ctxSize: 16384, useGpu: true, inConfig: true, preload: true, loaded: true, onDiskBytes: 2.4e9, cacheFile: "qwen3-4b.gguf" }),
  ],
  onDiskOnly: [
    invRow({ name: "WHISPER_BASE", addon: "whisper", onDiskBytes: 1.4e8, cacheFile: "whisper-base.gguf" }),
  ],
  catalogCount: 4,
  totalDiskBytes: 2.54e9,
};

const catalog: CatalogModel[] = [
  { name: "QWEN3_4B", addon: "llm", params: "4B", quantization: "q4_k_m", expectedSize: 2.4e9, cacheFile: "qwen3-4b.gguf" }, // already configured
  { name: "WHISPER_BASE", addon: "whisper", expectedSize: 1.4e8, cacheFile: "whisper-base.gguf" }, // already on disk
  { name: "NLLB_600M", addon: "nmt", params: "600M", expectedSize: 1.2e9, cacheFile: "nllb-600m.gguf", fit: { gb: 1.7, verdict: "fits", deviceGB: 24 } }, // available
  { name: "SDXL_TURBO", addon: "diffusion", expectedSize: 6.9e9, cacheFile: "sdxl-turbo.gguf" }, // available
];

const rows = buildModelRows(inv, catalog);
const byName = (n: string): TaggedRow[] => rows.filter((r) => r.name === n);

assert.equal(rows.length, 4, "1 configured + 1 downloaded + 2 available — no double count");
assert.equal(byName("QWEN3_4B").length, 1, "configured model appears once, never also as available");
assert.equal(byName("WHISPER_BASE").length, 1, "on-disk model appears once, never also as available");

const qwen = byName("QWEN3_4B")[0] as TaggedRow;
assert.equal(qwen.category, "configured", "config entry → configured");
assert.equal(qwen.kind, "text", "llm → text kind");

const whisper = byName("WHISPER_BASE")[0] as TaggedRow;
assert.equal(whisper.category, "downloaded", "on-disk-only → downloaded");
assert.equal(whisper.kind, "speech", "whisper → speech kind");

const available = rows.filter((r) => r.category === "available");
assert.deepEqual(available.map((r) => r.name).sort(), ["NLLB_600M", "SDXL_TURBO"], "only catalog residuals are available");

const nllb = byName("NLLB_600M")[0] as TaggedRow;
assert.equal(nllb.category, "available");
assert.equal(nllb.kind, "translation", "nmt → translation");
// sparse shape: live/config fields are nulled
assert.equal(nllb.alias, null, "available row has no alias");
assert.equal(nllb.ctxSize, null, "available row has no ctx");
assert.equal(nllb.useGpu, null, "available row has no compute");
assert.equal(nllb.tokPerSec, null, "available row has no measured speed");
assert.equal(nllb.onDiskBytes, null, "available row is not on disk");
assert.equal(nllb.inConfig, false);
assert.equal(nllb.preload, false);
assert.equal(nllb.loaded, false);
// catalog fields carried through
assert.equal(nllb.expectedSize, 1.2e9, "expectedSize from catalog");
assert.equal(nllb.cacheFile, "nllb-600m.gguf", "cacheFile from catalog");
assert.equal(nllb.params, "600M", "params from catalog");
assert.equal(nllb.fit.verdict, "fits", "fit carried from catalogWithFit");

const sdxl = byName("SDXL_TURBO")[0] as TaggedRow;
assert.equal(sdxl.kind, "image", "diffusion → image");
assert.equal(sdxl.fit.verdict, null, "catalog entry lacking fit → safe empty verdict, not a crash");

// ── modelState: one branch per state ───────────────────────────────────────────────
function tagged(category: ModelCategory, p: Partial<InventoryRow> & { name: string }): TaggedRow {
  return { ...invRow(p), category, kind: kindOf(p.addon) };
}

assert.equal(modelState(tagged("available", { name: "A" }), "ready"), "not-downloaded", "available → not-downloaded even when serve ready");
assert.equal(modelState(tagged("available", { name: "A" }), "stopped"), "not-downloaded", "available → not-downloaded when serve stopped");
assert.equal(modelState(tagged("configured", { name: "B", inConfig: true, preload: true, loaded: true }), "ready"), "loaded", "loaded on serve → loaded");
assert.equal(modelState(tagged("downloaded", { name: "C", onDiskBytes: 1e8 }), "ready"), "cached", "on disk, not configured → cached");
assert.equal(modelState(tagged("configured", { name: "D", inConfig: true, preload: true, loaded: false }), "stopped"), "serve-down", "configured + serve not ready → serve-down");
assert.equal(modelState(tagged("configured", { name: "D", inConfig: true, preload: true, loaded: false }), "starting"), "serve-down", "configured + serve starting → serve-down");
assert.equal(modelState(tagged("configured", { name: "E", inConfig: true, preload: true, loaded: false }), "ready"), "not-loaded", "configured + ready + preload, not yet loaded → not-loaded");
assert.equal(modelState(tagged("configured", { name: "F", inConfig: true, preload: false, loaded: false }), "ready"), "no-preload", "configured + ready + no preload → no-preload");

console.log("✅ model-rows — addon→kind map · merge dedups by name · sparse available rows · modelState all branches — GO");
