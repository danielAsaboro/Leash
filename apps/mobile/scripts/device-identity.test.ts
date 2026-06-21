import assert from "node:assert";
import { makeDeviceIdentity } from "../deviceIdentity";

const fresh = makeDeviceIdentity("fresh", 1_700_000_000_000);
assert.equal(fresh.source, "fresh");
assert.ok(fresh.id.startsWith("device-"));

const imported = makeDeviceIdentity("imported", 1_700_000_100_000);
assert.equal(imported.source, "imported");

console.log("device-identity.test.ts: ok");
