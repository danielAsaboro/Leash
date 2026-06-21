import assert from "node:assert";
import {
  createDeviceIdentity,
  createPendingBootstrap,
  completeBootstrap,
  bootstrapNeedsWelcome,
  routeNeedsWelcome,
} from "../lib/leash/device-bootstrap-core.ts";

const fresh = createDeviceIdentity("fresh", 1_700_000_000_000);
assert.equal(fresh.source, "fresh");
assert.ok(fresh.userId.startsWith("device-"));

const pending = createPendingBootstrap("first-device", fresh);
assert.equal(bootstrapNeedsWelcome(pending), true);

const ready = completeBootstrap(pending, 1_700_000_100_000);
assert.equal(bootstrapNeedsWelcome(ready), false);
assert.equal(ready.completedAt, 1_700_000_100_000);

assert.equal(routeNeedsWelcome("/home", true), false);
assert.equal(routeNeedsWelcome("/home", false), true);
assert.equal(routeNeedsWelcome("/welcome", false), false);
assert.equal(routeNeedsWelcome("/api/leash/bootstrap/state", false), false);
assert.equal(routeNeedsWelcome("/api/leash/device/active", false), false);

console.log("verify-device-bootstrap: ok");
