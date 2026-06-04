/** Pre-download Qwen3VL-2B (single-image VLM) + its mmproj into ~/.qvac cache. */
import { downloadAsset, close, QWEN3VL_2B_MULTIMODAL_Q4_K, MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K } from "@qvac/sdk";

const ASSETS: [string, unknown][] = [
  ["Qwen3VL-2B (vision base)", QWEN3VL_2B_MULTIMODAL_Q4_K],
  ["Qwen3VL-2B mmproj (projector)", MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K],
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
        if (pct !== last && pct % 20 === 0) {
          console.log(`   ${pct}%  (${(p.downloaded / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB)`);
          last = pct;
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    console.log(`   ✅ cached: ${label}`);
  }
  console.log("\n🎉 qwen3vl cached");
  await close();
}

main().catch((err) => {
  console.error("❌ warm-vl failed:", err);
  process.exit(1);
});
