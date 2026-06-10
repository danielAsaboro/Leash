/**
 * Pure-logic smoke for the metered watchdog's NON-destructive connection cutoff
 * (apps/hypha/src/device-provider.ts). Proves: a transient revoke excludes a consumer from the
 * firewall allow-list, auto-re-admits after its TTL, and is byte-identical to the union when empty
 * (so HYPHA_ECONOMY_REVOKE_ON_CUTOFF=0 leaves the proven firewall untouched).
 *
 *   npm run smoke:revoke
 */
import assert from "node:assert/strict";
import { effectiveAllow, pruneExpiredRevocations } from "../apps/hypha/src/device-provider.ts";

const union = new Set(["A", "B", "C"]);
const T0 = 1_000_000;

// Empty revocations → identical to the paired union (flag OFF = proven firewall byte-identical).
assert.deepEqual([...effectiveAllow(union, new Map(), T0)].sort(), ["A", "B", "C"], "no revocations → union unchanged");

// A non-expired revocation excludes exactly that consumer (the live cut).
const revoked = new Map<string, number>([["B", T0 + 30_000]]);
assert.deepEqual([...effectiveAllow(union, revoked, T0)].sort(), ["A", "C"], "B cut while its revocation is live");
assert.ok(effectiveAllow(union, revoked, T0).has("A") && effectiveAllow(union, revoked, T0).has("C"), "other consumers untouched");

// Once `now` passes the expiry, B auto-re-admits (cooldown, not an unpair).
assert.deepEqual([...effectiveAllow(union, revoked, T0 + 30_001)].sort(), ["A", "B", "C"], "B auto-re-admits after its TTL");

// pruneExpiredRevocations drops only expired entries (keeps the map bounded; live cuts stay).
const m = new Map<string, number>([["B", T0 - 1], ["C", T0 + 30_000]]);
pruneExpiredRevocations(m, T0);
assert.equal(m.has("B"), false, "expired revocation pruned");
assert.equal(m.has("C"), true, "live revocation retained");

// Full lifecycle: cut → still cut mid-cooldown → re-admitted after expiry+prune.
const live = new Map<string, number>();
live.set("B", T0 + 30_000); // watchdog cutoff at T0
assert.equal(effectiveAllow(union, live, T0 + 10_000).has("B"), false, "B stays cut through the cooldown");
pruneExpiredRevocations(live, T0 + 31_000);
assert.equal(live.size, 0, "expired cut pruned");
assert.equal(effectiveAllow(union, live, T0 + 31_000).has("B"), true, "B reconnectable after the cooldown");

console.log("✅ revoke — transient firewall cut · isolates one consumer · auto-re-admit after TTL · empty = byte-identical union — GO");
process.exit(0);
