/**
 * Pure-logic smoke for the metered (pay-as-you-go) session mechanism (apps/hypha/src/metered.ts).
 * No SDK, no chain — runs instantly. Verifies the escalating-authorization ladder, idempotent
 * replay, monotonicity guards, the close vs. cutoff charge selection, and the watchdog idle clock.
 *
 *   npm run smoke:metered
 */
import assert from "node:assert/strict";
import type { AuthorizationRung, MeteredState } from "../apps/hypha/src/economy-types.ts";
import type { PlasmaVerifiedBudget } from "../apps/hypha/src/plasma-settlement.ts";
import {
  initMeteredState,
  appendRung,
  topRung,
  settleTokensAtClose,
  settleTokensAtCutoff,
  rungToSettle,
  isIdleExpired,
  needsAdvanceBeforeChunk,
  cumulativeTokensForTier,
} from "../apps/hypha/src/metered.ts";

// perKiloToken = 1000 → amountForTokens(t) == t, so cumulativeAmount reads as "tokens" here.
const amount = (tokens: number): number => Math.ceil((tokens / 1000) * 1000);
const fakeVerified = (a: number): PlasmaVerifiedBudget =>
  ({ provider: "p", maxAmount: a, recipient: {} as never, paymentPayload: {} as never, accepted: {} as never });
const rung = (tierIndex: number, cumulativeTokens: number, at: string): AuthorizationRung => ({
  tierIndex,
  cumulativeTokens,
  cumulativeAmount: amount(cumulativeTokens),
  authorizationDigest: `dig-${tierIndex}`,
  verified: fakeVerified(amount(cumulativeTokens)),
  acceptedAt: at,
});

const cfg = { chunkTokens: 64, advanceWindowMs: 20_000 };
const t0 = "2026-06-10T00:00:00.000Z";

// ── init ──────────────────────────────────────────────────────────────────────────────────────
let s: MeteredState = initMeteredState(cfg, t0);
assert.equal(s.acceptedThroughTokens, 0);
assert.equal(topRung(s), undefined);
assert.equal(isIdleExpired(s, Date.parse(t0) + 9_999_999), false, "no rungs → never idle-cut");
assert.equal(needsAdvanceBeforeChunk(s, 0), true, "first chunk needs tier-0 first");
assert.equal(cumulativeTokensForTier(cfg, 0), 64);
assert.equal(cumulativeTokensForTier(cfg, 3), 256);

// ── tier-0 open ───────────────────────────────────────────────────────────────────────────────
let r = appendRung(s, rung(0, 64, "2026-06-10T00:00:01.000Z"));
s = r.state;
assert.equal(r.applied, true);
assert.equal(s.acceptedThroughTokens, 64);
assert.equal(needsAdvanceBeforeChunk(s, 0), false, "first chunk now covered");
assert.equal(needsAdvanceBeforeChunk(s, 64), true, "second chunk needs an advance");

// idempotent replay (same digest + cap) → no-op
r = appendRung(s, rung(0, 64, "2026-06-10T00:00:05.000Z"));
assert.equal(r.applied, false, "replayed advance is a no-op");
assert.equal(r.state.acceptedThroughTokens, 64);
// conflicting tier-0 (same tier, different cap) → throws
assert.throws(() => appendRung(s, rung(0, 128, t0)), /conflicts/);

// ── escalate tiers 1..3 ─────────────────────────────────────────────────────────────────────────
s = appendRung(s, rung(1, 128, "2026-06-10T00:00:02.000Z")).state;
s = appendRung(s, rung(2, 192, "2026-06-10T00:00:03.000Z")).state;
s = appendRung(s, rung(3, 256, "2026-06-10T00:00:04.000Z")).state;
assert.equal(s.acceptedThroughTokens, 256);
assert.equal(topRung(s)!.tierIndex, 3);
assert.equal(rungToSettle(s)!.cumulativeTokens, 256, "settle the highest rung");

// ── monotonicity guards ─────────────────────────────────────────────────────────────────────────
assert.throws(() => appendRung(s, rung(3, 300, t0)), /conflicts/, "same tier, higher cap = conflict");
assert.throws(() => appendRung(s, rung(4, 256, t0)), /does not raise/, "new tier must raise the cap");
assert.throws(() => appendRung(s, rung(2, 999, t0)), /conflicts/, "below-top tier is a conflict");

// ── close vs cutoff charge ──────────────────────────────────────────────────────────────────────
assert.equal(settleTokensAtClose(s, 200), 200, "under-cap report charged as-reported");
assert.equal(settleTokensAtClose(s, 999), 256, "over-cap report clamped to the authorized cap");
assert.equal(settleTokensAtClose(s, -5), 0, "negative report floored to 0");
assert.equal(settleTokensAtCutoff(s), 256, "abandonment charges the full authorized cap");

// ── watchdog idle clock (from the LAST advance @ …04) ───────────────────────────────────────────
const lastAt = Date.parse("2026-06-10T00:00:04.000Z");
assert.equal(isIdleExpired(s, lastAt + 19_000), false, "within window → alive");
assert.equal(isIdleExpired(s, lastAt + 21_000), true, "past window → idle-cut");

console.log("✅ metered mechanism — ladder · idempotency · monotonicity · close/cutoff charge · watchdog — GO");
process.exit(0);
