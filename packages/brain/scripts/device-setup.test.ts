import assert from "node:assert/strict";

import { decideDeviceSetup } from "../src/device-setup.ts";

const GB = 1024 ** 3;

const smallPhone = decideDeviceSetup({
  surface: "mobile",
  formFactor: "phone",
  totalMemoryBytes: 3 * GB,
  availableDiskBytes: 5 * GB,
  deviceYearClass: 2020,
});

assert.equal(smallPhone.profileId, "phone");
assert.equal(smallPhone.executionTarget, "local");
assert.equal(smallPhone.setupClass, "compact");
assert.equal(smallPhone.recommendedChatAlias, "qwen3-600m");

const ipad = decideDeviceSetup({
  surface: "mobile",
  formFactor: "tablet",
  totalMemoryBytes: 8 * GB,
  availableDiskBytes: 18 * GB,
  deviceYearClass: 2024,
  supportedCpuArchitectures: ["arm64"],
});

assert.equal(ipad.profileId, "phone");
assert.equal(ipad.executionTarget, "local");
assert.equal(ipad.setupClass, "full");
assert.equal(ipad.recommendedChatAlias, "qwen3-4b");
assert.ok(ipad.reasons.some((reason) => /tablet/i.test(reason)));

const desktop = decideDeviceSetup({
  surface: "desktop",
  formFactor: "desktop",
  totalMemoryBytes: 16 * GB,
  availableDiskBytes: 120 * GB,
  supportedCpuArchitectures: ["arm64"],
});

assert.equal(desktop.profileId, "desktop");
assert.equal(desktop.executionTarget, "local");
assert.equal(desktop.setupClass, "full");
assert.equal(desktop.recommendedChatAlias, "qwen3-4b");

const web = decideDeviceSetup({
  surface: "web",
  formFactor: "browser",
  totalMemoryBytes: 8 * GB,
  availableDiskBytes: 40 * GB,
});

assert.equal(web.profileId, "desktop");
assert.equal(web.executionTarget, "paired-hub");
assert.equal(web.setupClass, "full");
assert.equal(web.recommendedChatAlias, "qwen3-4b");
assert.ok(web.reasons.some((reason) => /browser/i.test(reason)));

console.log("device-setup.test.ts: ok");
