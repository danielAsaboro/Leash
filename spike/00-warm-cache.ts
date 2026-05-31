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
  QWEN3_4B_Q4_K_M,
  GTE_LARGE_FP16,
} from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("00-warm-cache");

const ASSETS: Array<[string, string]> = [
  ["GTE_LARGE_FP16 (embeddings, ~335M)", GTE_LARGE_FP16],
  ["QWEN3_600M_INST_Q4 (phone/Pi-class LLM)", QWEN3_600M_INST_Q4],
  ["LLAMA_3_2_1B_INST_Q4_0 (1B LLM)", LLAMA_3_2_1B_INST_Q4_0],
  ["QWEN3_4B_Q4_K_M (Mac-class LLM)", QWEN3_4B_Q4_K_M],
];

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
