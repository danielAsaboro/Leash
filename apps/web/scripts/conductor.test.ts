// apps/web/scripts/conductor.test.ts
/**
 * tsx assertion script (repo idiom). Verifies the Conductor's DETERMINISTIC paths only
 * (no live model): the fast-path picks the cheapest local general route for a greeting,
 * and barFromFallback maps effort+intent to a bar. Run: npx tsx apps/web/scripts/conductor.test.ts
 */
import assert from "node:assert";
import { barFromFallback, pickLocalGeneral } from "../lib/leash/conductor-utils.ts";
import type { RouteOption } from "@mycelium/leash-core/routing";

const local4b: RouteOption = { tier: "device", alias: "qwen3-4b", tags: { modality: "text", paramClass: "small", specialist: "general" }, pricePerKiloToken: 0, inflight: 0 };

function main() {
  // 1. Fallback bar: a deep text turn needs at least 'mid'.
  assert.equal(barFromFallback({ tier: "deep", isImageTurn: false, text: "analyze the tradeoffs" }).minParamClass, "mid", "deep turn → mid bar");
  // 2. Fallback bar: an image turn requires vision modality + specialist.
  const vb = barFromFallback({ tier: "standard", isImageTurn: true, text: "what's in this photo" });
  assert.equal(vb.modality, "vision", "image turn → vision bar");
  assert.equal(vb.specialist, "vision", "image turn → vision specialist");
  // 3. Fallback bar: health wording → health specialist.
  assert.equal(barFromFallback({ tier: "standard", isImageTurn: false, text: "what are my symptoms of anxiety" }).specialist, "health", "health words → health bar");
  // 4. pickLocalGeneral returns the cheapest local general route.
  assert.equal(pickLocalGeneral([local4b], "qwen3-4b").alias, "qwen3-4b", "fast-path picks local general");
  console.log("conductor: PASS");
}
main();
