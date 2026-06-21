import assert from "node:assert/strict";
import { clearEffortFailureCooldown, effortFailureCooldownRemaining, recordEffortFailure } from "../apps/web/lib/leash/effort-cooldown.ts";

clearEffortFailureCooldown();
assert.equal(effortFailureCooldownRemaining(1000), 0, "cooldown starts inactive");

assert.equal(recordEffortFailure(1000, 5000), true, "first failure should be logged");
assert.equal(effortFailureCooldownRemaining(1000), 5000, "cooldown starts at configured duration");
assert.equal(recordEffortFailure(2000, 5000), false, "failure inside cooldown should be quiet");
assert.equal(effortFailureCooldownRemaining(2000), 5000, "cooldown extends from the latest failure");
assert.equal(effortFailureCooldownRemaining(6999), 1, "cooldown remains active until expiry");
assert.equal(effortFailureCooldownRemaining(7000), 0, "cooldown expires");
assert.equal(recordEffortFailure(7001, 1000), true, "new failure after expiry should be logged");

clearEffortFailureCooldown();
assert.equal(effortFailureCooldownRemaining(8000), 0, "clear resets cooldown");

console.log("smoke:effort-cooldown PASS");
