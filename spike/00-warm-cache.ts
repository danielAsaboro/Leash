/**
 * Spike 00 — warm the model cache (run ONCE, online).
 *
 * Pre-downloads every GGUF weight the spike needs from the QVAC registry so all
 * later runs (01–04) are fully offline. `qvac.config.json` in the repo root is
 * auto-discovered by the SDK (swarmRelays empty = LAN/no relay).
 *
 *   npm run spike:warm
 */
import {
  downloadAsset,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
  QWEN3_600M_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  GTE_LARGE_FP16,
  WHISPER_BASE_Q8_0,
} from "@qvac/sdk";
// prettier-ignore
// @ts-ignore — OCR + diffusion/tts/parakeet/flux/wan constants are runtime exports absent from @qvac/sdk's root .d.ts.
import { OCR_LATIN_RECOGNIZER_1, OCR_CRAFT_DETECTOR, SD_V2_1_1B_Q8_0, FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M, TTS_EN_SUPERTONIC_Q8_0, PARAKEET_TDT_0_6B_V3_Q8_0, PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0, WAN2_1_T2V_1_3B_FP16, UMT5_XXL_FP16, WAN_2_1_COMFYUI_REPACKAGED_VAE } from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("00-warm-cache");

// Every model the spike AND the Week-1 slice need, so all flows run offline after
// one online warm. Council = QWEN3_4B_INST_Q4_K_M; trivial = QWEN3_600M_INST_Q4;
// embeddings = GTE_LARGE_FP16; voice STT = WHISPER_BASE_Q8_0. (LLAMA_3_2_1B is the
// spike's inference/RAG model.)
const ASSETS: Array<[string, string]> = [
  ["GTE_LARGE_FP16 (embeddings, ~335M)", GTE_LARGE_FP16],
  ["QWEN3_600M_INST_Q4 (trivial/local LLM)", QWEN3_600M_INST_Q4],
  ["LLAMA_3_2_1B_INST_Q4_0 (spike 1B LLM)", LLAMA_3_2_1B_INST_Q4_0],
  ["QWEN3_4B_INST_Q4_K_M (council LLM)", QWEN3_4B_INST_Q4_K_M],
  ["WHISPER_BASE_Q8_0 (voice STT)", WHISPER_BASE_Q8_0],
  // Photo OCR: the recognizer auto-pairs the CRAFT detector, so warm BOTH for offline.
  ["OCR_LATIN_RECOGNIZER_1 (photo OCR recognizer)", OCR_LATIN_RECOGNIZER_1],
  ["OCR_CRAFT_DETECTOR (photo OCR text detector)", OCR_CRAFT_DETECTOR],
  // The Understory newsroom: on-device hero images (Stable Diffusion 2.1, ~1B Q8) — fallback engine.
  ["SD_V2_1_1B_Q8_0 (newsroom hero diffusion, fallback)", SD_V2_1_1B_Q8_0],
  // 0.12.0 flagship — FLUX.2 [klein] hero images (split-layout: diffusion + LLM text-encoder + VAE).
  ["FLUX_2_KLEIN_4B_Q4_0 (Flux2 diffusion, ~2.46 GB)", FLUX_2_KLEIN_4B_Q4_0],
  ["QWEN3_4B_Q4_K_M (Flux2 text encoder, ~2.5 GB)", QWEN3_4B_Q4_K_M],
  ["FLUX_2_KLEIN_4B_VAE (Flux2 VAE decoder)", FLUX_2_KLEIN_4B_VAE],
  // 0.12.0 TTS — read-aloud (GGML Supertonic, English).
  ["TTS_EN_SUPERTONIC_Q8_0 (read-aloud TTS, ~252 MB)", TTS_EN_SUPERTONIC_Q8_0.src],
  // 0.12.0 Parakeet — diarized voice memos (Sortformer diarizer + TDT transcriber).
  ["PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0 (diarization)", PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0],
  ["PARAKEET_TDT_0_6B_V3_Q8_0 (segment transcription)", PARAKEET_TDT_0_6B_V3_Q8_0],
];

// Wan 2.1 text-to-video (Tier 2c) is gated: UMT5-XXL is very large and Apple-Silicon
// video is slow/unproven. Warm only when explicitly spiking video: `SPIKE_WARM_VIDEO=1`.
if (process.env.SPIKE_WARM_VIDEO === "1") {
  ASSETS.push(
    ["WAN2_1_T2V_1_3B_FP16 (text-to-video diffusion)", WAN2_1_T2V_1_3B_FP16],
    ["UMT5_XXL_FP16 (Wan text encoder, LARGE)", UMT5_XXL_FP16],
    ["WAN_2_1_COMFYUI_REPACKAGED_VAE (Wan VAE)", WAN_2_1_COMFYUI_REPACKAGED_VAE],
  );
}

try {
  for (const [label, assetSrc] of ASSETS) {
    console.log(`\n📥 Warming: ${label}`);
    const t0 = now();
    let lastPct = -1;
    await downloadAsset({
      assetSrc,
      onProgress: (p) => {
        const pct = Math.floor(p.percentage);
        if (pct !== lastPct && pct % 10 === 0) {
          const mb = (p.downloaded / 1024 / 1024).toFixed(0);
          const tot = (p.total / 1024 / 1024).toFixed(0);
          console.log(`   ${pct}%  (${mb}/${tot} MB)`);
          lastPct = pct;
        }
      },
    });
    const durationMs = now() - t0;
    audit.record({ event: "model_load", modelSrc: assetSrc, durationMs, extra: { phase: "download", label } });
    console.log(`   ✅ cached (${(durationMs / 1000).toFixed(1)}s)`);
  }
  console.log(`\n🎉 Cache warm. Spikes 01–04 can now run offline. Log: ${audit.path}`);
  await close();
} catch (error) {
  console.error("❌ warm-cache failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exit(1);
}
