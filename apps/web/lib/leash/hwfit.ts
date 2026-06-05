/**
 * Device fit (server-only) — will a model run on THIS machine?
 *
 * The Mac has UNIFIED memory (CPU+GPU share one pool); `hw.memsize` is the whole of
 * it. A model needs: its weights (we use the catalog's real `expectedSize` when known,
 * far better than estimating from params), plus a KV cache that grows with context,
 * plus ~0.5 GB runtime overhead. We compare that to a budget of ~80% of total memory —
 * the rest is the OS, the app, and headroom. (Adapted from Odysseus `services/hwfit`,
 * but grounded in our real download sizes rather than a params×bpp estimate.)
 *
 * Honest scope: the verdict is PER MODEL IN ISOLATION ("fits alone"). The serve holds
 * every preloaded model at once, so several "fits alone" models can still overflow
 * together — the UI says "alone" so that's not misread.
 */
import "server-only";
import { execSync } from "node:child_process";
import { totalmem } from "node:os";

/** Bytes-per-param fallback when a model has no `expectedSize` (catalog gap). */
const QUANT_BPP: Record<string, number> = {
  f32: 4.0, f16: 2.0, bf16: 2.0, fp8: 1.0, fp4: 0.5, int4: 0.5, int8: 1.0,
  q8_0: 1.05, q6_k: 0.8, q5_k_m: 0.68, q4_k_m: 0.58, q4_0: 0.58, q4: 0.58, q3_k_m: 0.48, q2_k: 0.37,
};

/** Fraction of total unified memory we treat as usable for one model. */
const BUDGET_FRACTION = 0.8;

let memCache: number | null = null;

/** Total unified memory in GB (cached; 0 if undetectable). */
export function deviceMemoryGB(): number {
  if (memCache !== null) return memCache;
  let bytes = 0;
  try {
    // macOS reports unified memory via sysctl; everything else uses os.totalmem.
    bytes = process.platform === "darwin" ? Number(execSync("sysctl -n hw.memsize", { encoding: "utf8" }).trim()) : totalmem();
  } catch {
    bytes = totalmem();
  }
  if (!(bytes > 0)) bytes = totalmem();
  memCache = bytes > 0 ? bytes / 1e9 : 0;
  return memCache;
}

/** Parse a `params` string like "4B" / "600M" / "1.7B" → billions. */
function paramsB(params: string | null | undefined): number {
  if (!params) return 0;
  const m = /([\d.]+)\s*([bm])/i.exec(params);
  if (!m) return 0;
  const n = parseFloat(m[1] as string);
  return (m[2] as string).toLowerCase() === "m" ? n / 1000 : n;
}

export interface FitEstimate {
  /** Estimated peak memory to serve the model, in GB. */
  gb: number;
  /** fits | tight | too-big, against ~80% of unified memory. null = can't estimate. */
  verdict: "fits" | "tight" | "too-big" | null;
  /** Total unified memory (GB) the verdict was computed against. */
  deviceGB: number;
}

/**
 * Estimate peak serving memory and verdict for one model.
 * `expectedSize` (bytes) is the real weight size from the catalog; when absent we fall
 * back to params×bytes-per-param. `ctx` defaults to a typical 4096-token window.
 */
export function estimateFit(opts: { expectedSize?: number | null; params?: string | null; quantization?: string | null; ctx?: number }): FitEstimate {
  const device = deviceMemoryGB();
  const pB = paramsB(opts.params);
  const ctx = opts.ctx ?? 4096;

  let weightGB: number | null = null;
  if (opts.expectedSize && opts.expectedSize > 1e6) {
    weightGB = opts.expectedSize / 1e9;
  } else if (pB > 0) {
    const bpp = QUANT_BPP[(opts.quantization ?? "").toLowerCase()] ?? 0.58;
    weightGB = pB * bpp;
  }
  if (weightGB === null || device <= 0) return { gb: 0, verdict: null, deviceGB: device };

  // KV cache ≈ 8 KB per param-billion per token (Odysseus's 0.000008·paramsB·ctx GB).
  const kvGB = pB > 0 ? 0.000008 * pB * ctx : 0;
  const gb = weightGB + kvGB + 0.5; // +0.5 GB runtime overhead

  const budget = device * BUDGET_FRACTION;
  const verdict: FitEstimate["verdict"] = gb <= budget ? "fits" : gb <= device ? "tight" : "too-big";
  return { gb: Math.round(gb * 10) / 10, verdict, deviceGB: device };
}
