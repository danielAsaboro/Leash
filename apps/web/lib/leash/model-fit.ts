/**
 * Device-fit math — PURE + isomorphic (no `server-only`, no Node), so the context-size slider
 * can re-estimate live in the browser as the user drags it. The server estimator
 * (`hwfit.ts estimateFit`) is just this + unified-memory detection; keeping the math here means
 * the badge the slider shows and the badge the server renders come from ONE implementation.
 *
 * A model needs its weights (the catalog's real `expectedSize` when known, else params×bpp),
 * plus a KV cache that grows with the context window, plus ~0.5 GB runtime overhead — compared
 * to ~80% of unified memory. Verdict is PER MODEL IN ISOLATION ("fits alone").
 * Unit-tested by `scripts/smoke-model-fit.ts`.
 */

/** Bytes-per-param fallback when a model has no `expectedSize` (catalog gap). */
const QUANT_BPP: Record<string, number> = {
  f32: 4.0, f16: 2.0, bf16: 2.0, fp8: 1.0, fp4: 0.5, int4: 0.5, int8: 1.0,
  q8_0: 1.05, q6_k: 0.8, q5_k_m: 0.68, q4_k_m: 0.58, q4_0: 0.58, q4: 0.58, q3_k_m: 0.48, q2_k: 0.37,
};

/** Fraction of total unified memory we treat as usable for one model. */
const BUDGET_FRACTION = 0.8;

export interface FitEstimate {
  /** Estimated peak memory to serve the model, in GB. */
  gb: number;
  /** fits | tight | too-big, against ~80% of unified memory. null = can't estimate. */
  verdict: "fits" | "tight" | "too-big" | null;
  /** Total unified memory (GB) the verdict was computed against. */
  deviceGB: number;
}

/** Parse a `params` string like "4B" / "600M" / "1.7B" → billions. */
export function paramsB(params: string | null | undefined): number {
  if (!params) return 0;
  const m = /([\d.]+)\s*([bm])/i.exec(params);
  if (!m) return 0;
  const n = parseFloat(m[1] as string);
  return (m[2] as string).toLowerCase() === "m" ? n / 1000 : n;
}

/**
 * Estimate peak serving memory + verdict for one model, given the device's unified memory in GB
 * (so this stays pure — the caller supplies `deviceGB`). `expectedSize` (bytes) is the real
 * weight size; absent, we fall back to params×bpp. `ctx` defaults to a typical 4096-token window.
 */
export function fitFromSpec(spec: {
  deviceGB: number;
  expectedSize?: number | null;
  params?: string | null;
  quantization?: string | null;
  ctx?: number;
}): FitEstimate {
  const device = spec.deviceGB;
  const pB = paramsB(spec.params);
  const ctx = spec.ctx ?? 4096;

  let weightGB: number | null = null;
  if (spec.expectedSize && spec.expectedSize > 1e6) {
    weightGB = spec.expectedSize / 1e9;
  } else if (pB > 0) {
    const bpp = QUANT_BPP[(spec.quantization ?? "").toLowerCase()] ?? 0.58;
    weightGB = pB * bpp;
  }
  if (weightGB === null || device <= 0) return { gb: 0, verdict: null, deviceGB: device };

  // KV cache ≈ 8 KB per param-billion per token (0.000008·paramsB·ctx GB).
  const kvGB = pB > 0 ? 0.000008 * pB * ctx : 0;
  const gb = weightGB + kvGB + 0.5; // +0.5 GB runtime overhead

  const budget = device * BUDGET_FRACTION;
  const verdict: FitEstimate["verdict"] = gb <= budget ? "fits" : gb <= device ? "tight" : "too-big";
  return { gb: Math.round(gb * 10) / 10, verdict, deviceGB: device };
}
