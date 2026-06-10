/**
 * Pure-logic smoke for the consumer connectivity self-heal decision
 * (apps/hypha/src/connectivity-manager.ts `decideHeal`). Proves the manager decides to
 * suspend()/resume()+re-warm ONLY on a real disruption — a wall-clock wake-gap (device slept) or
 * a cluster of consecutive all-providers-unreachable ticks (network roam) — never on a single
 * provider blip, never on the first tick, and never inside the heal cooldown.
 *
 *   npm run smoke:reconnect
 */
import assert from "node:assert/strict";
import { decideHeal, initialReconnectState, type ReconnectConfig } from "../apps/hypha/src/connectivity-manager.ts";

const cfg: ReconnectConfig = { wakeGapMs: 30_000, healCooldownMs: 60_000, allFailThreshold: 2 };
const T = 1_000_000;

// 1) First tick establishes a baseline — it never heals (no prior tick to measure a gap against).
let s = initialReconnectState();
let r = decideHeal(s, { now: T, providersProbed: 2, providersFailed: 2 }, cfg);
assert.equal(r.heal, false, "first tick never heals (no baseline gap)");
assert.equal(r.state.consecutiveAllFail, 1, "but all-fail still counts from the first tick");
s = r.state;

// 2) A second consecutive all-fail tick reaches the threshold → heal (network roam).
r = decideHeal(s, { now: T + 15_000, providersProbed: 2, providersFailed: 2 }, cfg);
assert.equal(r.heal, true, "two consecutive all-fail ticks → heal");
assert.equal(r.reason, "all-providers-unreachable", "roam reason");
assert.equal(r.state.consecutiveAllFail, 0, "all-fail counter resets after a heal");
s = r.state;

// 3) Inside the cooldown, even another all-fail cluster must NOT heal again (anti-thrash).
let r3 = decideHeal(s, { now: T + 16_000, providersProbed: 2, providersFailed: 2 }, cfg);
r3 = decideHeal(r3.state, { now: T + 17_000, providersProbed: 2, providersFailed: 2 }, cfg);
assert.equal(r3.heal, false, "cooldown blocks a second heal");

// 4) A partial failure (1 of 2) is a single-provider blip — never a heal, and it resets the counter.
let s4 = initialReconnectState();
s4 = decideHeal(s4, { now: T, providersProbed: 2, providersFailed: 2 }, cfg).state; // count=1
r = decideHeal(s4, { now: T + 10_000, providersProbed: 2, providersFailed: 1 }, cfg);
assert.equal(r.heal, false, "partial failure → no heal");
assert.equal(r.state.consecutiveAllFail, 0, "partial success resets the all-fail counter");

// 5) A wall-clock gap larger than wakeGapMs → heal (device slept), regardless of providers.
let s5 = initialReconnectState();
s5 = decideHeal(s5, { now: T, providersProbed: 1, providersFailed: 0 }, cfg).state;
r = decideHeal(s5, { now: T + 40_000, providersProbed: 1, providersFailed: 0 }, cfg);
assert.equal(r.heal, true, "wall-clock gap > wakeGapMs → heal");
assert.equal(r.reason, "wake-gap", "wake reason");

// 6) "0 of 0 probed" is NOT an all-unreachable signal (nothing to talk to ≠ network down).
let s6 = initialReconnectState();
s6 = decideHeal(s6, { now: T, providersProbed: 0, providersFailed: 0 }, cfg).state;
r = decideHeal(s6, { now: T + 5_000, providersProbed: 0, providersFailed: 0 }, cfg);
assert.equal(r.heal, false, "no providers probed → no roam heal");
assert.equal(r.state.consecutiveAllFail, 0, "0/0 does not increment the all-fail counter");

console.log("✅ reconnect — first-tick-safe · roam cluster (consecutive all-fail) · wake-gap · cooldown anti-thrash · partial-blip ignored · 0/0 ignored — GO");
