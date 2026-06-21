import assert from "node:assert/strict";
import { optionsForRouteIntent } from "../lib/leash/route-intent.ts";

const local = { tier: "device" as const, id: "local" };
const paired = { tier: "private" as const, id: "paired" };
const publicProvider = { tier: "public" as const, id: "public" };

assert.deepEqual(optionsForRouteIntent([local, paired], "public"), [], "explicit public must fail closed instead of falling back");
assert.deepEqual(optionsForRouteIntent([local, publicProvider], "private"), [], "explicit private must not fall back locally or publicly");
assert.deepEqual(optionsForRouteIntent([paired, publicProvider], "local"), [], "explicit local must not borrow a peer");
assert.deepEqual(optionsForRouteIntent([local, paired, publicProvider], "automatic").map((option) => option.id), ["local", "paired", "public"], "automatic keeps every eligible fallback tier for deterministic conductor ranking");
assert.deepEqual(optionsForRouteIntent([paired, publicProvider], "automatic").map((option) => option.id), ["paired", "public"], "automatic falls through when no local capability is eligible");
assert.deepEqual(optionsForRouteIntent([publicProvider], "automatic").map((option) => option.id), ["public"], "automatic may select public only after local/private candidates are absent");
assert.deepEqual(optionsForRouteIntent([local, paired, publicProvider], "public").map((option) => option.id), ["public"]);

console.log("route-intent.test.ts: explicit modes fail closed; automatic retains eligible fallback tiers");
