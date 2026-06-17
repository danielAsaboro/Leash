/**
 * tsx assertion script (repo idiom). Verifies rankRoutes: privacy gate drops public for
 * sensitive turns; capability filter drops under-powered local; cheapest-that-clears wins;
 * a saturated local loses to a free peer; empty-after-filter returns [].
 * Run: npx tsx packages/leash-core/scripts/routing-rank.test.ts
 */
import assert from "node:assert";
import { rankRoutes } from "../src/routing/rank.ts";
import type { RouteOption, CapabilityBar } from "../src/routing/types.ts";

const local4b: RouteOption = { tier: "device", alias: "qwen3-4b", tags: { modality: "text", paramClass: "small", specialist: "general" }, pricePerKiloToken: 0, inflight: 0 };
const peerBig: RouteOption = { tier: "private", alias: "qwen3-32b", peerKey: "PK_PRO", meshId: "primary", modelSrc: "src://big", tags: { modality: "text", paramClass: "large", specialist: "general" }, pricePerKiloToken: 500, inflight: 0 };
const publicBig: RouteOption = { tier: "public", alias: "qwen3-32b", peerKey: "PK_PUB", meshId: "open", tags: { modality: "text", paramClass: "large", specialist: "general" }, pricePerKiloToken: 10, inflight: 0 };

function main() {
  const easyBar: CapabilityBar = { modality: "text", minParamClass: "small" };
  const hardBar: CapabilityBar = { modality: "text", minParamClass: "large" };

  // 1. Easy bar, idle local clears it → local (price 0) wins over a paid peer.
  let r = rankRoutes({ bar: easyBar, sensitivity: "private", options: [local4b, peerBig] });
  assert.equal(r[0]?.alias, "qwen3-4b", "idle local should win an easy turn");

  // 2. Hard bar → local 'small' is filtered out; the 'large' peer wins.
  r = rankRoutes({ bar: hardBar, sensitivity: "private", options: [local4b, peerBig] });
  assert.equal(r.length, 1, "only the large peer should clear a hard bar");
  assert.equal(r[0]?.peerKey, "PK_PRO", "hard turn should route to the large peer");

  // 3. Privacy gate: sensitive ('private') hard turn must NEVER pick the cheaper public peer.
  r = rankRoutes({ bar: hardBar, sensitivity: "private", options: [peerBig, publicBig] });
  assert.ok(r.every((x) => x.tier !== "public"), "private sensitivity must exclude public tier");
  assert.equal(r[0]?.peerKey, "PK_PRO", "sensitive hard turn → private peer, not cheaper public");

  // 4. Shareable hard turn MAY use the cheaper public peer.
  r = rankRoutes({ bar: hardBar, sensitivity: "shareable", options: [peerBig, publicBig] });
  assert.equal(r[0]?.peerKey, "PK_PUB", "shareable turn should take the cheaper public peer");

  // 5. Saturated local loses to a free peer on an easy turn (load offload).
  const busyLocal = { ...local4b, inflight: 3 };
  const freePeerSmall: RouteOption = { tier: "private", alias: "qwen3-4b", peerKey: "PK_FREE", meshId: "primary", modelSrc: "src://s", tags: { modality: "text", paramClass: "small", specialist: "general" }, pricePerKiloToken: 100, inflight: 0 };
  r = rankRoutes({ bar: easyBar, sensitivity: "private", options: [busyLocal, freePeerSmall] });
  assert.equal(r[0]?.peerKey, "PK_FREE", "saturated local should offload to a free peer");

  // 6. Nothing clears the bar → [].
  r = rankRoutes({ bar: { modality: "vision", minParamClass: "small" }, sensitivity: "private", options: [local4b] });
  assert.deepEqual(r, [], "no vision route → empty (caller falls back to local)");

  console.log("routing-rank: PASS");
}
main();
