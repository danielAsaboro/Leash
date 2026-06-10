/**
 * Smoke: bounded-signing safety layer (Machine Economy v2 — spec §10, Hard Rule 6).
 *
 *   npx tsx packages/mesh/scripts/smoke-spend-policy.ts
 *
 * Proves the guardrail that makes autonomous agent payment safe: a prompt-injected agent passing
 * arbitrary providers/tokens CANNOT exceed the caps, pay a non-allow-listed counterparty, or set its
 * own amount. Pure + deterministic (a fake clock, a fake pay()).
 *
 * GO when every cap holds, budget reservations really reserve against the float, and a failed
 * pay() refunds cleanly (no phantom spend).
 */
import { SpendGuard, authorizeSettlement, type PayFn, type SpendLimits, type PriceSheet } from "../src/index.ts";

function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}

const LIMITS: SpendLimits = { maxPerTx: 100, maxPerHour: 250, maxPerCounterparty: 150 };
const PRICE: PriceSheet = { perKiloToken: 10 }; // 10 units / 1k tokens
const PRO = "pro-provider-key";
const STRANGER = "0xattacker-controlled";

try {
  // ── AMOUNT IS PROTOCOL-SET, NOT MODEL-SET ────────────────────────────────────────────────────
  const d = authorizeSettlement({ provider: PRO, tokens: 4120 }, PRICE, LIMITS, new Set([PRO]), 1000, [], 0);
  expect("amount is computed from the price sheet (4120 tok @ 10/1k = 42), not the request", d.ok && d.amount === 42);

  // ── ALLOW-LIST ───────────────────────────────────────────────────────────────────────────────
  const stranger = authorizeSettlement({ provider: STRANGER, tokens: 100 }, PRICE, LIMITS, new Set([PRO]), 1000, [], 0);
  expect("a non-allow-listed counterparty is REJECTED (no paying strangers)", !stranger.ok);

  // ── PER-TX CAP (prompt-injected huge token count) ────────────────────────────────────────────
  const huge = authorizeSettlement({ provider: PRO, tokens: 1_000_000 }, PRICE, LIMITS, new Set([PRO]), 1_000_000, [], 0);
  expect("a prompt-injected huge settlement is REJECTED by the per-tx cap", !huge.ok);

  // ── FLOAT BOUND ──────────────────────────────────────────────────────────────────────────────
  const broke = authorizeSettlement({ provider: PRO, tokens: 5000 }, PRICE, LIMITS, new Set([PRO]), 30, [], 0);
  expect("a settlement above the remaining hot-wallet float is REJECTED", !broke.ok);

  // ── HOURLY + PER-COUNTERPARTY CAPS via the live guard ────────────────────────────────────────
  let clock = 1_000_000;
  const paid: Array<{ provider: string; amount: number }> = [];
  const pay: PayFn = async (provider, amount) => { paid.push({ provider, amount }); return { txRef: `tx-${paid.length}` }; };
  const guard = new SpendGuard({ ...LIMITS }, PRICE, new Set([PRO]), 1000, pay, () => clock);

  const a = await guard.settleInference({ provider: PRO, tokens: 8000 }); // 80
  const b = await guard.settleInference({ provider: PRO, tokens: 6000 }); // 60 → cp total 140 ok
  expect("two in-window settlements to the same provider succeed under caps", a.ok && b.ok);
  const cpOver = await guard.settleInference({ provider: PRO, tokens: 2000 }); // +20 → cp 160 > 150
  expect("the per-counterparty hourly cap REJECTS the next one", !cpOver.ok);
  expect("float debited by exactly what was paid (1000 - 140 = 860)", guard.float === 860);
  expect("pay() called once per approved settlement only (2)", paid.length === 2);

  // window rolls forward an hour → caps reset
  clock += 3_600_001;
  const later = await guard.settleInference({ provider: PRO, tokens: 5000 }); // 50, fresh window
  expect("after the 1h window rolls, the per-counterparty cap resets", later.ok);

  // ── FAILED PAY REFUNDS (no phantom spend) ────────────────────────────────────────────────────
  const failGuard = new SpendGuard({ ...LIMITS }, PRICE, new Set([PRO]), 500, async () => { throw new Error("rpc down"); }, () => clock);
  const failed = await failGuard.settleInference({ provider: PRO, tokens: 3000 });
  expect("a failed on-chain pay() is REJECTED and the float is refunded (no phantom debit)", !failed.ok && failGuard.float === 500);

  // ── PRE-COMPUTE BUDGET RESERVATIONS (x402 `upto`) ────────────────────────────────────────────
  const reserved: Array<{ provider: string; amount: number; auth: string }> = [];
  const reserveGuard = new SpendGuard({ ...LIMITS }, PRICE, new Set([PRO]), 200, async () => ({ txRef: "unused" }), () => clock);
  const r1 = reserveGuard.reserveBudget({ provider: PRO, amount: 90 });
  expect("a compute budget can be RESERVED before the run", r1.ok && typeof r1.reservationId === "string");
  expect("the reservation immediately debits the float (200 - 90 = 110)", reserveGuard.float === 110);
  const r2 = reserveGuard.reserveBudget({ provider: PRO, amount: 60 });
  expect("a second reservation within remaining room also succeeds", r2.ok);
  const r3 = reserveGuard.reserveBudget({ provider: PRO, amount: 10 });
  expect("an overlapping reservation that would breach the per-counterparty hourly cap is REJECTED", !r3.ok);
  const cap = await reserveGuard.captureBudget(
    r1.reservationId!,
    42,
    async (provider, amount, auth) => {
      reserved.push({ provider, amount, auth: String(auth) });
      return { txRef: "x402-tx-1" };
    },
    "auth-1",
  );
  expect("capturing below the reserved cap settles the ACTUAL amount", cap.ok && cap.amount === 42);
  expect("capturing below the cap refunds the UNUSED portion immediately (50 + (90 - 42) = 98)", reserveGuard.float === 98);
  const released = reserveGuard.releaseBudget(r2.reservationId!);
  expect("a canceled budget reservation refunds in full", released && reserveGuard.float === 158);

  console.log("\n🟢 PASS — bounded signing: protocol-set amount, allow-list, caps, real budget reservations, refund-on-fail");
} catch (err) {
  console.error("\n🔴 FAIL:", err);
  process.exitCode = 1;
}
