/**
 * Offline smoke for private/public mesh routing safety and load ranking.
 * Run: npm run smoke:p2p-routing
 */
import assert from "node:assert";
import { rankRoutes, tagsForAlias, type RouteOption } from "../packages/leash-core/src/routing/index.ts";

const options: RouteOption[] = [
  { tier: "device", alias: "qwen3-4b", tags: tagsForAlias("qwen3-4b"), pricePerKiloToken: 0, inflight: 4 },
  { tier: "private", alias: "qwen3-4b", tags: tagsForAlias("qwen3-4b"), peerKey: "peer-fast", meshId: "mesh-private", pricePerKiloToken: 500, inflight: 0 },
  { tier: "public", alias: "qwen3-4b", tags: tagsForAlias("qwen3-4b"), peerKey: "peer-public", meshId: "mesh-public", pricePerKiloToken: 1, inflight: 0 },
  { tier: "private", alias: "medpsy", tags: tagsForAlias("medpsy"), peerKey: "peer-joy", meshId: "mesh-private", pricePerKiloToken: 1000, inflight: 0 },
];

const privateRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small" }, sensitivity: "private", options });
assert.ok(privateRanked.every((r) => r.tier !== "public"), "private sensitivity excludes public mesh");
assert.equal(privateRanked[0]!.peerKey, "peer-fast", "saturated local loses to less-loaded private peer");

const shareableRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small" }, sensitivity: "shareable", options });
assert.equal(shareableRanked[0]!.tier, "public", "shareable low-cost public route can win");

const healthRanked = rankRoutes({ bar: { modality: "text", minParamClass: "small", specialist: "health" }, sensitivity: "private", options });
assert.equal(healthRanked[0]!.alias, "medpsy", "health route selects health specialist");
assert.equal(healthRanked[0]!.tier, "private", "health specialist stays private");

console.log("smoke:p2p-routing PASS");
