/**
 * Offline smoke for private/public mesh routing safety and load ranking.
 * Run: npm run smoke:p2p-routing
 */
import assert from "node:assert";
import { rankRoutes, tagsForAlias, type RouteOption } from "../packages/leash-core/src/routing/index.ts";

const options: RouteOption[] = [
  { tier: "device", alias: "qwen3-4b", tags: tagsForAlias("qwen3-4b"), pricePerKiloToken: 0, inflight: 4 },
  { tier: "private", alias: "qwen3-4b", tags: tagsForAlias("qwen3-4b"), peerKey: "peer-fast", meshId: "mesh-private", pricePerKiloToken: 0, inflight: 0 },
  { tier: "public", alias: "qwen3-4b", tags: tagsForAlias("qwen3-4b"), peerKey: "peer-public", meshId: "mesh-public", pricePerKiloToken: 1, inflight: 0 },
  { tier: "private", alias: "health", tags: tagsForAlias("health"), peerKey: "peer-joy", meshId: "mesh-private", pricePerKiloToken: 0, inflight: 0 },
  { tier: "private", alias: "ocr", tags: tagsForAlias("ocr"), peerKey: "peer-ocr", meshId: "mesh-private", pricePerKiloToken: 0, inflight: 0 },
];

const privateRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small" }, sensitivity: "private", options });
assert.ok(privateRanked.every((r) => r.tier !== "public"), "private sensitivity excludes public mesh");
assert.equal(privateRanked[0]!.peerKey, "peer-fast", "saturated local loses to less-loaded private peer");

const shareableRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small" }, sensitivity: "shareable", options });
assert.equal(shareableRanked[0]!.tier, "private", "shareable route still prefers zero-rate private when it clears");

const publicOnlyRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small" }, sensitivity: "shareable", options: options.filter((o) => o.tier !== "private" && o.tier !== "device") });
assert.equal(publicOnlyRanked[0]!.tier, "public", "shareable route may use public when private cannot clear");

const healthRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small", specialist: "health" }, sensitivity: "private", options });
assert.equal(healthRanked[0]!.alias, "health", "health route selects health specialist");
assert.equal(healthRanked[0]!.tier, "private", "health specialist stays private");

const ocrRanked = rankRoutes({ bar: { modality: "ocr", minParamClass: "tiny", specialist: "ocr" }, sensitivity: "private", options });
assert.equal(ocrRanked[0]!.alias, "ocr", "OCR route selects OCR specialist");
assert.equal(ocrRanked[0]!.tier, "private", "OCR route stays private");

console.log("smoke:p2p-routing PASS");
