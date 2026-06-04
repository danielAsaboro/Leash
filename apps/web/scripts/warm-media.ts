/**
 * Pre-download the download-gated Leash media models into the QVAC cache (~/.qvac).
 *
 *   npm run warm:media        (online, one-time; minutes — GB-scale)
 *
 * Uses `downloadAsset` (caches weights WITHOUT loading them into memory), so it doesn't
 * OOM or disturb the running `qvac serve`. After this, vision + the MedGemma specialist
 * can be served on demand. SmolVLM2-500M is the small/fast vision option; swap to
 * QWEN3VL_2B for higher quality (bigger download).
 */
import { downloadAsset, close, MEDGEMMA_4B_IT_Q4_1, SMOLVLM2_500M_MULTIMODAL_Q8_0, MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0 } from "@qvac/sdk";

const ASSETS: [string, unknown][] = [
  ["MedGemma 4B IT Q4_1 (P4 health specialist)", MEDGEMMA_4B_IT_Q4_1],
  ["SmolVLM2 500M (vision base)", SMOLVLM2_500M_MULTIMODAL_Q8_0],
  ["SmolVLM2 500M mmproj (vision projector)", MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0],
];

async function main(): Promise<void> {
  for (const [label, assetSrc] of ASSETS) {
    console.log(`\n📥 ${label}`);
    let last = -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await downloadAsset({
      assetSrc,
      onProgress: (p: { percentage: number; downloaded: number; total: number }) => {
        const pct = Math.floor(p.percentage);
        if (pct !== last && pct % 10 === 0) {
          console.log(`   ${pct}%  (${(p.downloaded / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB)`);
          last = pct;
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    console.log(`   ✅ cached: ${label}`);
  }
  console.log("\n🎉 media weights cached — vision + MedGemma can now be served.");
  await close();
}

main().catch((err) => {
  console.error("❌ warm-media failed:", err);
  process.exit(1);
});
