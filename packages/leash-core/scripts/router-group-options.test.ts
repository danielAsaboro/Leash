/** Pure regression checks for converting Hypha peer rows into executable routes. */
import assert from "node:assert";
import { rowToOptions } from "../src/groups/router.ts";

const base = {
  deviceId: "device-pro",
  displayName: "Pro",
  providerKey: "f".repeat(64),
  computeClass: "desktop",
  ramMB: 32_768,
  powerState: "plugged",
  inflight: 0,
  models: ["qwen3-4b", "vision-4b"],
  modelInfo: [
    { alias: "qwen3-4b", modelType: "chat", borrowable: true },
    { alias: "vision-4b", modelType: "vision", borrowable: false },
  ],
  warmModels: ["qwen3-4b"],
  live: true,
  warm: true,
  lastSeen: new Date().toISOString(),
  meshId: "primary",
  meshLabel: "Primary",
  visibility: "private" as const,
  tier: 0,
};

assert.deepEqual(rowToOptions({ ...base, live: false }), [], "stale peers are not executable routes");
const { providerKey: _providerKey, ...withoutProviderKey } = base;
assert.deepEqual(rowToOptions(withoutProviderKey), [], "truncated/legacy peer ids cannot pin execution");
const options = rowToOptions(base);
assert.equal(options.length, 2, "forward-routable aliases remain available even when SDK borrowing is disabled");
assert.equal(options[0]?.alias, "qwen3-4b");
assert.equal(options[1]?.alias, "vision-4b");
assert.equal(options[0]?.peerKey, base.providerKey, "full provider key drives the pin");
assert.equal(options[0]?.pricePerKiloToken, 0, "private routes are policy-free");

console.log("router-group-options: PASS");
