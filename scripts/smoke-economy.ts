/**
 * Pure-logic smoke for the Economy tab derivation (apps/web/lib/leash/economy.ts). No I/O.
 * Proves the wallet/provider-key join, the earn/spend split, accountability surfacing, the
 * live-unknown-peer path, and the cumulative sparkline series.
 *
 *   npm run smoke:economy
 */
import assert from "node:assert/strict";
import { deriveEconomy, type EconomyPeer, type EconomyReceipt, type EconomyReputation } from "../apps/web/lib/leash/economy.ts";

const ME = "0xMe0000000000000000000000000000000000bEEF";
const MINI = "0xMini00000000000000000000000000000000Cafe";
const ALICE = "0xA11ce0000000000000000000000000000000Face";

const earn = (tx: string, amt: number, tok: number, at: string): EconomyReceipt =>
  ({ sessionId: tx, alias: "medpsy", actualTokens: tok, actualAmount: amt, asset: "USDT0", txHash: tx, status: "settled", payerAddress: ALICE, providerAddress: ME, providerId: "PSELF", settledAt: at, completedAt: at, networkId: "eip155:9746" });
const spend = (tx: string, amt: number, tok: number, at: string): EconomyReceipt =>
  ({ sessionId: tx, alias: "qwen3-4b", actualTokens: tok, actualAmount: amt, asset: "USDT0", txHash: tx, status: "settled", payerAddress: ME, providerAddress: MINI, providerId: "PMINI", settledAt: at, completedAt: at, networkId: "eip155:9746" });

const receipts: EconomyReceipt[] = [
  earn("0xe1", 100, 100, "2026-06-10T10:00:00Z"),
  spend("0xs1", 50, 50, "2026-06-10T10:01:00Z"),
  earn("0xe2", 200, 200, "2026-06-10T10:02:00Z"),
  { ...earn("0xr1", 999, 10, "2026-06-10T10:03:00Z"), status: "retrying", txHash: "" }, // mine, NOT settled
];
const reputation: EconomyReputation[] = [
  { providerId: "PSELF", score: 0.8, quality: 0.4, accountable: true, settledCount: 2, distinctPayers: 1, unsettledCount: 0 },
  { providerId: "PMINI", score: 0.5, quality: 0.5, accountable: true, settledCount: 5, distinctPayers: 3, unsettledCount: 1 },
];
const peers: EconomyPeer[] = [
  { deviceId: "dMini", displayName: "mini-provider", live: true, inflight: 0, pricePerKiloToken: 1000, reputationScore: 0.5, effectiveCost: 2000, settlement: { recipient: MINI, asset: "USDT0", networkId: "eip155:9746" } },
  { deviceId: "dNew", displayName: "fresh-peer", live: true, inflight: 0, pricePerKiloToken: 1200, reputationScore: 0.1, effectiveCost: 24000, settlement: { recipient: "0xNew000000000000000000000000000000000aaaa" } }, // no reputation/receipts
];

const snap = deriveEconomy(receipts, reputation, peers, { providerKey: "PSELF", wallet: ME });

// ── Earn/spend split + totals ────────────────────────────────────────────────────────────────────
assert.equal(snap.earned, 300, "earned = settled receipts paid TO my wallet (100+200)");
assert.equal(snap.spent, 50, "spent = settled receipts paid BY my wallet (50)");
assert.equal(snap.net, 250, "net = earned − spent");
assert.equal(snap.settledCount, 3, "settledCount excludes the retrying receipt");
assert.equal(snap.receipts.length, 4, "all 4 of my receipts appear in the ledger (incl. retrying)");
assert.equal(snap.receipts[0]!.sessionId, "0xr1", "ledger sorted newest-first → the retrying receipt (10:03) is first");
assert.equal(snap.receipts[0]!.status, "retrying", "unsettled obligations stay visible at the top");
assert.equal(snap.receipts.find((r) => r.status === "settled")!.txHash, "0xe2", "newest SETTLED receipt is 0xe2 (10:02)");
assert.equal(snap.receipts.find((r) => r.txHash === "0xs1")!.direction, "spend", "spend tagged by payer==me");

// ── Cumulative sparkline series (time-ordered earn 100→300, spend 0→50) ──────────────────────────
assert.deepEqual(snap.earnedSeries, [100, 100, 300], "cumulative earned over time");
assert.deepEqual(snap.spentSeries, [0, 50, 50], "cumulative spent over time");

// ── Market join + accountability + ordering ──────────────────────────────────────────────────────
const mini = snap.market.find((m) => m.providerId === "PMINI")!;
assert.equal(mini.displayName, "mini-provider", "PMINI joined to its live peer by wallet");
assert.equal(mini.pricePerKiloToken, 1000, "price from the live peer");
assert.equal(mini.effectiveCost, 2000, "effectiveCost from the live peer");
assert.equal(mini.accountable, true, "PMINI accountable from /reputation");
assert.equal(mini.live, true, "PMINI live");
const self = snap.market.find((m) => m.providerId === "PSELF")!;
assert.equal(self.isSelf, true, "PSELF flagged isSelf");
assert.equal(self.pricePerKiloToken, 1000, "self price derived from its own receipts (100µ/100tok·1000)");
assert.ok(snap.market[snap.market.length - 1]!.isSelf, "self sinks to the bottom of the market");
const fresh = snap.market.find((m) => m.displayName === "fresh-peer")!;
assert.equal(fresh.accountable, false, "a live PAID peer with no reputation/receipts is surfaced but NOT accountable");
assert.equal(fresh.pricePerKiloToken, 1200, "fresh peer price from /peers");

// ── No self.wallet → can't attribute earn/spend, but market still builds ──────────────────────────
const anon = deriveEconomy(receipts, reputation, peers, { providerKey: null, wallet: null });
assert.equal(anon.earned, 0, "no wallet → no earnings attributed");
assert.equal(anon.spent, 0, "no wallet → no spend attributed");
assert.equal(anon.receipts.length, 0, "no wallet → no personal ledger");
assert.ok(anon.market.length >= 2, "market still builds without a self wallet");

console.log("✅ economy — wallet/key join · earn/spend split · accountability surfacing · live-unknown peer · cumulative sparklines — GO");
process.exit(0);
