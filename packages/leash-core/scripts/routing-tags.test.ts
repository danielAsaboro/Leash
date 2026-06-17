/**
 * tsx assertion script (repo idiom). Verifies tagsForAlias: known aliases resolve
 * from the table; advertised tags win for unknown aliases; unknown+no-advert falls
 * back to a general text last-resort. Run: npx tsx packages/leash-core/scripts/routing-tags.test.ts
 */
import assert from "node:assert";
import { tagsForAlias } from "../src/routing/tags.ts";

function main() {
  // 1. Known specialist alias resolves from the table.
  assert.equal(tagsForAlias("qwen3vl").modality, "vision", "qwen3vl should be vision");
  assert.equal(tagsForAlias("medpsy").specialist, "health", "medpsy should be health");
  assert.equal(tagsForAlias("qwen3-4b").paramClass, "small", "qwen3-4b should be small");

  // 2. Unknown alias with advertised tags prefers the advertised values (public-mesh seam).
  const adv = tagsForAlias("stranger-model", { modality: "vision", paramClass: "large" });
  assert.equal(adv.modality, "vision", "advertised modality should win for unknown alias");
  assert.equal(adv.paramClass, "large", "advertised paramClass should win for unknown alias");

  // 3. Unknown alias, no advertised tags → general text last-resort.
  const fb = tagsForAlias("who-knows");
  assert.deepEqual(
    { m: fb.modality, p: fb.paramClass, s: fb.specialist },
    { m: "text", p: "unknown", s: "general" },
    "unknown alias should fall back to general/text/unknown",
  );
  console.log("routing-tags: PASS");
}
main();
