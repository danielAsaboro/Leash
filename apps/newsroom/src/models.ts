/**
 * Typed model-constant shim (mirrors packages/senses/src/models.ts).
 *
 * `SD_V2_1_1B_Q8_0` is a real runtime export of `@qvac/sdk` but — like the LLM /
 * embedding constants — it's absent from the package's root `.d.ts`, so importing it
 * as a value fails type-check. We import it behind a one-line `@ts-ignore` and
 * re-export it typed as a `modelSrc`, keeping every consumer strict.
 */
import type { LoadModelOptions } from "@qvac/sdk";
// prettier-ignore
// @ts-ignore — present at runtime; absent from @qvac/sdk's root .d.ts (gap persists in 0.12.1).
import { SD_V2_1_1B_Q8_0 as _SD_V2_1_1B_Q8_0, FLUX_2_KLEIN_4B_Q4_0 as _FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE as _FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M as _QWEN3_4B_Q4_K_M, REALESRGAN_X4PLUS_ANIME_6B as _REALESRGAN_X4PLUS_ANIME_6B, WAN2_1_T2V_1_3B_FP16 as _WAN2_1_T2V_1_3B_FP16, UMT5_XXL_FP16 as _UMT5_XXL_FP16, WAN_2_1_COMFYUI_REPACKAGED_VAE as _WAN_2_1_COMFYUI_REPACKAGED_VAE } from "@qvac/sdk";

export type ModelSrc = LoadModelOptions["modelSrc"];

/** Stable Diffusion 2.1 (1B, Q8) — single all-in-one GGUF, on-device hero images.
 * Kept as the fallback engine after the Flux2-klein swap. */
export const SD_V2_1_1B_Q8_0: ModelSrc = _SD_V2_1_1B_Q8_0;

// ── 0.12.0: FLUX.2 [klein] hero images (split-layout) ─────────────────────────
// Flux is flow-matching (NOT v-prediction). Load the diffusion GGUF as modelSrc and
// pass the LLM text-encoder + VAE via modelConfig.{llmModelSrc,vaeModelSrc}.
/** FLUX.2 [klein] 4B diffusion model (Q4_0, ~2.46 GB). Metal "matches MLX" in 0.12. */
export const FLUX_2_KLEIN_4B_Q4_0: ModelSrc = _FLUX_2_KLEIN_4B_Q4_0;
/** FLUX.2 [klein] VAE (decoder) — companion to the diffusion model. */
export const FLUX_2_KLEIN_4B_VAE: ModelSrc = _FLUX_2_KLEIN_4B_VAE;
/** Qwen3-4B (Q4_K_M) used by Flux as its LLM **text encoder** (engine sdcpp-generation,
 * addon diffusion) — distinct file from the council's QWEN3_4B_INST_Q4_K_M chat LLM. */
export const QWEN3_4B_Q4_K_M: ModelSrc = _QWEN3_4B_Q4_K_M;
/** RealESRGAN x4 upscaler — optional GPU upscale paired with a diffusion model. */
export const REALESRGAN_X4PLUS_ANIME_6B: ModelSrc = _REALESRGAN_X4PLUS_ANIME_6B;

// ── 0.12.0: Wan 2.1 text-to-video (split-layout, Tier 2c — env-gated) ─────────
// Needs ≥16 GB VRAM / 20 GB unified memory; slow on Metal — spike before shipping.
/** Wan 2.1 T2V 1.3B diffusion model (FP16). Loaded modelType:"diffusion", mode:"video". */
export const WAN2_1_T2V_1_3B_FP16: ModelSrc = _WAN2_1_T2V_1_3B_FP16;
/** UMT5-XXL (FP16) — Wan's text encoder (large; gated behind SPIKE_WARM_VIDEO). */
export const UMT5_XXL_FP16: ModelSrc = _UMT5_XXL_FP16;
/** Wan 2.1 VAE (ComfyUI repackaged) — video decoder companion. */
export const WAN_2_1_COMFYUI_REPACKAGED_VAE: ModelSrc = _WAN_2_1_COMFYUI_REPACKAGED_VAE;
