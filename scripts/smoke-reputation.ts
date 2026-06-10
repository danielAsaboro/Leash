/**
 * Pure-logic smoke for reputation scoring (apps/hypha/src/reputation.ts). No I/O — runs instantly.
 * Proves the credibility centerpiece: a self-dealing / wash-trading provider (all volume from one
 * payer) scores BELOW a legitimate provider with fewer-but-distinct payers.
 *
 *   npm run smoke:reputation
 */
import assert from "node:assert/strict";
import type { ReceiptLike, ProviderObservation } from "../apps/hypha/src/reputation.ts";
import { computeReputation, effectiveCost, ReputationStore } from "../apps/hypha/src/reputation.ts";

const settled = (providerId: string, payerAddress: string): ReceiptLike =>
  ({ providerId, payerAddress, status: "settled", txHash: "0xdeadbeef", actualAmount: 100 });
const settledTx = (providerId: string, payerAddress: string, txHash: string): ReceiptLike =>
  ({ providerId, payerAddress, status: "settled", txHash, actualAmount: 100, providerAddress: "0xpayee" });
const retrying = (providerId: string, payerAddress: string): ReceiptLike =>
  ({ providerId, payerAddress, status: "retrying", txHash: "", actualAmount: 100 });

// A = wash trader: 10 settled receipts, ALL from one payer. B = legit: 3 settled, 3 distinct payers.
const wash: ReceiptLike[] = Array.from({ length: 10 }, () => settled("A", "0xself"));
const legit: ReceiptLike[] = [settled("B", "0xp1"), settled("B", "0xp2"), settled("B", "0xp3")];
// C = unsettled only (retrying / no txHash) → must not count at all.
const unsettled: ReceiptLike[] = [
  { providerId: "C", payerAddress: "0xp9", status: "retrying", txHash: "", actualAmount: 100 },
  { providerId: "C", payerAddress: "0xp9", status: "settled", txHash: "", actualAmount: 100 }, // settled but no txHash → not real
];

const rep = computeReputation([...wash, ...legit, ...unsettled], []);

const a = rep.get("A")!;
const b = rep.get("B")!;
assert.ok(a, "wash provider present");
assert.ok(b, "legit provider present");
assert.equal(a.settledCount, 10, "A raw settled count is 10");
assert.equal(a.distinctPayers, 1, "A has a single payer");
assert.equal(a.weightedVolume, 3, "A volume capped at perPayerCap (wash-resistant)");
assert.equal(b.distinctPayers, 3, "B has 3 distinct payers");
assert.equal(b.weightedVolume, 3, "B volume = 3 (1 per distinct payer)");
assert.ok(b.score > a.score, `legit (${b.score}) must outscore wash (${a.score}) despite A's 10 raw receipts`);
assert.ok(a.quality < 0.4, `wash credibility floored (quality=${a.quality})`);
assert.equal(b.quality, 1, "B fully credible (3 distinct payers, no failures)");
assert.equal(rep.has("C"), false, "unsettled / no-txHash receipts never count");
// Phase-4 fields default to inert when accountability is disabled (byte-identical Phase-3 scoring).
assert.equal(a.accountable, true, "accountability disabled → accountable defaults true");
assert.equal(a.unsettledCount, 0, "A carries no unsettled receipts");

// Quality reflects local observations (failures + latency).
const obs: ProviderObservation[] = [
  { providerId: "D", ok: true, ttftMs: 200 },
  { providerId: "D", ok: true, ttftMs: 300 },
  { providerId: "D", ok: false },
  { providerId: "D", ok: false },
];
const repD = computeReputation([settled("D", "0xq1"), settled("D", "0xq2"), settled("D", "0xq3")], obs).get("D")!;
assert.equal(repD.successRate, 0.5, "D success rate from observations");
assert.equal(repD.quality, 0.5, "D quality = successRate × credibility(1) × latency(1)");

// effectiveCost: flaky/wash provider is effectively more expensive; unknown provider competes but floored.
assert.ok(effectiveCost(1000, a) > effectiveCost(1000, b), "wash provider's effective cost is higher at equal price");
assert.equal(effectiveCost(1000, b), 1000, "fully-credible provider pays face price");
assert.ok(effectiveCost(1000, undefined) >= 20000, "unknown provider floored (competes but not blindly trusted)");

// ── Phase 4: accountability (wallet↔key binding) + slashing-lite (pure) ──────────────────────────
// Same receipts; B is BOUND, A is NOT. With accountability enabled, an UNBOUND provider is FLOORED —
// you can't farm reputation without a wallet that actually received real on-chain USDT0.
const acctRep = computeReputation([...wash, ...legit], [], {}, { enabled: true, boundProviders: new Set(["B"]) });
assert.equal(acctRep.get("B")!.accountable, true, "B is bound + has verified volume → accountable");
assert.equal(acctRep.get("A")!.accountable, false, "A is unbound → not accountable");
assert.ok(acctRep.get("B")!.quality > acctRep.get("A")!.quality, "unbound A quality floored below bound B");
assert.ok(acctRep.get("B")!.score > acctRep.get("A")!.score, "bound provider outscores unbound at equal volume");

// On-chain DISPROVEN (verified===false) receipts are excluded from volume AND count as unsettled (slashed).
const forged = [settled("F", "0xp1"), settled("F", "0xp2"), { ...settled("F", "0xp3"), verified: false }];
const fRep = computeReputation(forged, [], {}, { enabled: true, boundProviders: new Set(["F"]) }).get("F")!;
assert.equal(fRep.weightedVolume, 2, "disproven receipt excluded from volume");
assert.equal(fRep.unsettledCount, 1, "disproven receipt counted as unsettled (slashed)");

// Slashing-lite: a provider carrying unsettled (retrying) receipts scores below a clean one at equal settled volume.
const slashRep = computeReputation(
  [settled("G", "0xp1"), settled("G", "0xp2"), settled("G", "0xp3"),
   settled("H", "0xp1"), settled("H", "0xp2"), settled("H", "0xp3"), retrying("H", "0xp4"), retrying("H", "0xp5")],
  [], {}, { enabled: true, boundProviders: new Set(["G", "H"]) },
);
assert.ok(slashRep.get("G")!.score > slashRep.get("H")!.score, "clean provider outscores one carrying unsettled receipts");
assert.equal(slashRep.get("H")!.unsettledCount, 2, "H carries 2 unsettled receipts");

// ── ReputationStore: ingestion + ranker (the routing/display surface) ───────────────────────────
const store = new ReputationStore();
await store.setReceipts([...wash, ...legit]);
store.recordObservation({ providerId: "B", ok: true, ttftMs: 200 });
store.recordObservation({ providerId: "A", ok: false });
const snap = store.snapshot();
assert.ok(snap.length >= 2, "snapshot lists providers");
assert.ok(snap[0]!.score >= snap[snap.length - 1]!.score, "snapshot sorted best-first");
assert.ok((store.score("B") ?? 0) > (store.score("A") ?? 0), "store.score: legit > wash");
assert.equal(store.score("ZZZ-unseen"), undefined, "unseen provider has no score");
// Ranker: paid wash provider is effectively more expensive than the legit one at equal price.
assert.ok(store.effectiveCost("A", 1000) > store.effectiveCost("B", 1000), "ranker: wash effectiveCost > legit");
assert.ok(store.effectiveCost("ZZZ-unseen", 1000) >= 20000, "ranker: unknown floored (competes, not blindly trusted)");
// Cache invalidation: a new settled receipt for a 4th distinct payer lifts B's wash-resistant volume.
const beforeVol = store.scoreFor("B")!.weightedVolume;
await store.setReceipts([...wash, ...legit, settled("B", "0xp4")]);
assert.ok(store.scoreFor("B")!.weightedVolume > beforeVol, "setReceipts invalidates cache + recomputes");

// ── Phase 4: ReputationStore on-chain verification layer (async, injected verifier + binder) ──────
const realTx = "0xreal", bogusTx = "0xbogus";
const vStore = new ReputationStore({
  verifyReceipt: async (r) => r.txHash === realTx, // only the real tx is confirmed on-chain
  isBound: (id) => id === "P",                      // P is wallet↔key bound; Q is not
});
await vStore.setReceipts([
  settledTx("P", "0xa", realTx),
  settledTx("P", "0xb", realTx),
  settledTx("P", "0xc", bogusTx), // FABRICATED — a bogus txHash that never settled on-chain
]);
const p = vStore.scoreFor("P")!;
assert.equal(p.weightedVolume, 2, "bogus-txHash receipt ignored (on-chain verify failed)");
assert.equal(p.unsettledCount, 1, "the disproven (forged) receipt is slashed");
assert.equal(p.accountable, true, "P is bound + has verified volume → accountable");
// Verifier cache: re-ingesting the same txHashes must not change the verdict (txHashes are immutable).
await vStore.setReceipts([settledTx("P", "0xa", realTx), settledTx("P", "0xb", realTx), settledTx("P", "0xc", bogusTx)]);
assert.equal(vStore.scoreFor("P")!.weightedVolume, 2, "verify cache stable across re-ingest");

// An UNBOUND provider whose receipts DO settle on-chain is still floored (binding is required for full trust).
const uStore = new ReputationStore({ verifyReceipt: async () => true, isBound: () => false });
await uStore.setReceipts([settledTx("Q", "0xa", realTx), settledTx("Q", "0xb", "0xt2"), settledTx("Q", "0xc", "0xt3")]);
const q = uStore.scoreFor("Q")!;
assert.equal(q.accountable, false, "unbound provider not accountable despite real on-chain receipts");
assert.ok(q.quality < 0.5, `unbound provider floored (quality=${q.quality})`);

console.log("✅ reputation — distinctPayers anti-self-deal · settled+txHash gating · quality from obs · effectiveCost · store/ranker · Phase-4 accountability+slashing+on-chain-verify — GO");
process.exit(0);
