/**
 * Pure-logic smoke for the device-fit estimator's client-callable core
 * (apps/web/lib/leash/model-fit.ts `fitFromSpec`). This is the math the context-size slider
 * re-runs live as the user drags it (the server `estimateFit` is just `fitFromSpec` + device
 * detection). Proves: weight from real size or params×bpp, KV cache scaling with ctx, the
 * fits/tight/too-big verdict vs ~80% of unified memory, and null when unestimatable.
 *
 *   npm run smoke:model-fit
 */
import assert from "node:assert/strict";
import { fitFromSpec } from "../apps/web/lib/leash/model-fit.ts";

// qwen3-4b (~2.4 GB weights) on a 24 GB Mac at a 16k context → comfortably fits.
let f = fitFromSpec({ deviceGB: 24, expectedSize: 2.4e9, params: "4B", quantization: "q4_k_m", ctx: 16384 });
assert.equal(f.gb, 3.4, "weight 2.4 + kv(16k) 0.52 + 0.5 overhead ≈ 3.4 GB");
assert.equal(f.verdict, "fits", "3.4 GB << 19.2 GB budget → fits");
assert.equal(f.deviceGB, 24, "device passes through");

// The KV cache grows with context — a huge window lifts the estimate.
const big = fitFromSpec({ deviceGB: 24, expectedSize: 2.4e9, params: "4B", quantization: "q4_k_m", ctx: 131072 });
assert.ok(big.gb > f.gb, "bigger ctx → more memory");
assert.equal(big.gb, 7.1, "weight 2.4 + kv(128k) 4.19 + 0.5 ≈ 7.1 GB");

// Same model + huge ctx, but on smaller devices → the verdict degrades (this is the slider's warning).
assert.equal(fitFromSpec({ deviceGB: 8, expectedSize: 2.4e9, params: "4B", quantization: "q4_k_m", ctx: 131072 }).verdict, "tight", "7.1 GB on 8 GB (budget 6.4) → tight");
assert.equal(fitFromSpec({ deviceGB: 4, expectedSize: 2.4e9, params: "4B", quantization: "q4_k_m", ctx: 131072 }).verdict, "too-big", "7.1 GB > 4 GB → too-big");

// No real size → fall back to params × bytes-per-param.
const byParams = fitFromSpec({ deviceGB: 24, params: "4B", quantization: "q4_k_m", ctx: 4096 });
assert.equal(byParams.gb, 3.0, "4B × 0.58 bpp = 2.32 + kv(4k) 0.13 + 0.5 ≈ 3.0 GB");

// Unestimatable inputs → null verdict (no weight, or no device memory).
assert.equal(fitFromSpec({ deviceGB: 24, ctx: 8192 }).verdict, null, "no size + no params → can't estimate");
assert.equal(fitFromSpec({ deviceGB: 0, expectedSize: 2.4e9, params: "4B", ctx: 8192 }).verdict, null, "no device memory → can't estimate");

console.log("✅ model-fit — weight(size|params×bpp) · KV scales with ctx · fits/tight/too-big vs 80% budget · null-safe — GO");
