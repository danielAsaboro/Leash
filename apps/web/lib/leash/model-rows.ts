/**
 * Models-tab browser core — PURE + isomorphic (no `server-only`, no Node), so the unified model
 * list can be tagged/classified the same way on the server (initial paint) as the math the
 * fit estimator already shares. Keeping this here means the `addon → kind` map, the merge that
 * folds configured + on-disk + downloadable into ONE list, and the per-row state classifier all
 * live in one tested place. Unit-tested by `scripts/smoke-model-rows.ts`.
 *
 * Imports are TYPE-ONLY (erased at build) — this file pulls no runtime code from the server-only
 * `models.ts`, so it is safe to import from a browser bundle or a plain `tsx` smoke.
 */
import type { InventoryRow, CatalogModel, ModelsInventory } from "./models.ts";
import type { ServeStatus } from "./serve-control.ts";

/** Visual kind of a model — the catalog `addon` collapsed to the modalities a human filters by. */
export type ModelKind = "text" | "image" | "speech" | "embedding" | "ocr" | "translation" | "other";

/** Which of the three list slices a row belongs to (drives the status filter). */
export type ModelCategory = "configured" | "downloaded" | "available";

/** An inventory row tagged with its category + visual kind — the unit the unified table renders. */
export interface TaggedRow extends InventoryRow {
  category: ModelCategory;
  kind: ModelKind;
}

/**
 * Catalog `addon` → visual kind. The catalog's `addon` is the one signal present on BOTH
 * `InventoryRow` and `CatalogModel`, so it classifies configured / on-disk / available rows
 * uniformly. NOTE: multimodal VLMs are `addon: "llm"` in the catalog, so they classify as
 * **text** — there is no reliable "vision" flag in the data (the visual modalities that DO exist
 * are image-generation `diffusion` and `ocr`).
 */
const ADDON_KIND: Record<string, ModelKind> = {
  llm: "text",
  diffusion: "image",
  embeddings: "embedding",
  parakeet: "speech",
  whisper: "speech",
  tts: "speech",
  nmt: "translation",
  ocr: "ocr",
};

/** Map a catalog `addon` to a visual kind; unknown / missing → "other". */
export function kindOf(addon: string | null | undefined): ModelKind {
  return ADDON_KIND[addon ?? ""] ?? "other";
}

/**
 * Fold the three inventory slices into ONE tagged, de-duplicated list:
 *   · configured (`InventoryRow`)              → category "configured"
 *   · onDiskOnly (`InventoryRow`)              → category "downloaded"
 *   · catalog entries not in either of the above (by `name`) → category "available"
 *
 * `available` rows are SPARSE: only the catalog-known fields (name/addon/engine/params/
 * quantization/expectedSize/cacheFile/fit) are carried; everything that needs a config entry,
 * disk presence, or live serve (alias/ctxSize/useGpu/tokPerSec/onDiskBytes) is null, and
 * inConfig/preload/isDefault/loaded are false. A name in configured or onDiskOnly is therefore
 * never also emitted as available — no double-counting.
 */
export function buildModelRows(inv: ModelsInventory, catalog: CatalogModel[]): TaggedRow[] {
  const configured = inv.configured.map((r): TaggedRow => ({ ...r, category: "configured", kind: kindOf(r.addon) }));
  const downloaded = inv.onDiskOnly.map((r): TaggedRow => ({ ...r, category: "downloaded", kind: kindOf(r.addon) }));
  const taken = new Set<string>([...inv.configured, ...inv.onDiskOnly].map((r) => r.name));
  const available = catalog
    .filter((c) => !taken.has(c.name))
    .map((c): TaggedRow => ({
      name: c.name,
      alias: null,
      addon: c.addon ?? null,
      engine: c.engine ?? null,
      params: c.params ?? null,
      quantization: c.quantization ?? null,
      ctxSize: null,
      useGpu: null,
      tokPerSec: null,
      fit: c.fit ?? { gb: 0, verdict: null, deviceGB: 0 },
      expectedSize: c.expectedSize ?? null,
      cacheFile: c.cacheFile ?? null,
      onDiskBytes: null,
      inConfig: false,
      preload: false,
      isDefault: false,
      loaded: false,
      category: "available",
      kind: kindOf(c.addon),
    }));
  return [...configured, ...downloaded, ...available];
}

/** Lifecycle state of a row — drives the State icon and its hover sentence. */
export type ModelState = "loaded" | "not-loaded" | "no-preload" | "serve-down" | "cached" | "not-downloaded";

/**
 * Classify a row's lifecycle state (mirrors the inline logic the old three-table panel used):
 *   · available                                  → not-downloaded
 *   · live on the serve                          → loaded
 *   · on disk, not configured                    → cached
 *   · configured but the serve isn't ready        → serve-down
 *   · configured + ready + preload (not yet up)   → not-loaded
 *   · configured + ready + no preload            → no-preload
 */
export function modelState(r: TaggedRow, serveState: ServeStatus["state"]): ModelState {
  if (r.category === "available") return "not-downloaded";
  if (r.loaded) return "loaded";
  if (r.category === "downloaded") return "cached";
  if (serveState !== "ready") return "serve-down";
  return r.preload ? "not-loaded" : "no-preload";
}
