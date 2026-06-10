/**
 * Economy tab — PURE derivation (no I/O, no `server-only`) so it unit-smokes without Next.
 *
 * Turns the three hypha shim reads (`/receipts`, `/reputation`, `/peers` + its new `self`) into the
 * judge-facing Ledger view: this device's earnings vs spend, a cross-provider market (reputation,
 * price, effective cost, accountability), and its own settlement receipts with on-chain tx refs.
 *
 * The join is by wallet + provider key (no field links peers↔reputation directly):
 *   receipt.providerAddress  ==  peer.settlement.recipient   (the bound payout wallet)
 *   receipt.providerId       ==  reputation.providerId       (the provider public key)
 *   self.wallet              ==  receipt.providerAddress  → EARNING (paid to me)
 *   self.wallet              ==  receipt.payerAddress     → SPEND    (paid by me)
 */

// ── Inputs (structural subsets of the shim payloads) ─────────────────────────────────────────────
export interface EconomyReceipt {
  sessionId: string;
  alias: string;
  actualTokens: number;
  actualAmount: number;
  asset: string;
  txHash: string;
  status: "settled" | "retrying" | "closed" | string;
  payerAddress: string;
  providerAddress: string;
  providerId: string;
  settledAt: string | null;
  completedAt: string;
  networkId?: string;
}
export interface EconomyReputation {
  providerId: string;
  score: number;
  quality: number;
  accountable: boolean;
  settledCount: number;
  distinctPayers: number;
  unsettledCount: number;
}
export interface EconomyPeer {
  deviceId: string;
  displayName: string;
  live: boolean;
  inflight: number;
  pricePerKiloToken?: number;
  reputationScore?: number;
  effectiveCost?: number;
  settlement?: { recipient?: string; asset?: string; networkId?: string } | null;
}
export interface EconomySelf {
  providerKey: string | null;
  wallet: string | null;
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────────
export interface MarketRow {
  providerId: string;
  displayName: string;
  wallet: string | null;
  score: number;
  accountable: boolean;
  pricePerKiloToken: number | null;
  effectiveCost: number | null;
  settledCount: number;
  distinctPayers: number;
  unsettledCount: number;
  live: boolean;
  isSelf: boolean;
}
export interface LedgerReceipt {
  sessionId: string;
  alias: string;
  tokens: number;
  amount: number;
  asset: string;
  txHash: string;
  status: string;
  direction: "earn" | "spend" | "other";
  counterparty: string;
  at: string;
}
export interface EconomySnapshot {
  wallet: string | null;
  asset: string;
  networkId: string | null;
  earned: number;
  spent: number;
  net: number;
  settledCount: number;
  /** Cumulative µ-amount over this device's settled receipts (one point per settle, time-ordered). */
  earnedSeries: number[];
  spentSeries: number[];
  market: MarketRow[];
  receipts: LedgerReceipt[];
}

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();
const QUALITY_FLOOR = 0.05;

/** Pure: fold the three reads into the Ledger snapshot. Deterministic; never throws on missing fields. */
export function deriveEconomy(
  receipts: readonly EconomyReceipt[],
  reputation: readonly EconomyReputation[],
  peers: readonly EconomyPeer[],
  self: EconomySelf,
): EconomySnapshot {
  const wallet = self.wallet ? lc(self.wallet) : null;

  // provider key → wallet + a sample alias, learned from receipts (the only place both appear).
  const walletByProvider = new Map<string, string>();
  const priceFromReceipts = new Map<string, number>();
  for (const r of receipts) {
    if (r.providerId && r.providerAddress && !walletByProvider.has(r.providerId)) walletByProvider.set(r.providerId, r.providerAddress);
    if (r.providerId && r.actualTokens > 0 && !priceFromReceipts.has(r.providerId)) {
      priceFromReceipts.set(r.providerId, Math.round((r.actualAmount / r.actualTokens) * 1000));
    }
  }
  const peerByWallet = new Map<string, EconomyPeer>();
  for (const p of peers) { const w = lc(p.settlement?.recipient); if (w) peerByWallet.set(w, p); }

  // ── Market: one row per provider known via reputation, enriched with live peer price/availability. ──
  const market: MarketRow[] = [];
  const covered = new Set<string>();
  for (const rep of reputation) {
    covered.add(rep.providerId);
    const w = walletByProvider.get(rep.providerId) ?? null;
    const peer = w ? peerByWallet.get(lc(w)) : undefined;
    const price = peer?.pricePerKiloToken ?? priceFromReceipts.get(rep.providerId) ?? null;
    const effectiveCost = peer?.effectiveCost ?? (price != null ? Math.round(price / Math.max(rep.quality, QUALITY_FLOOR)) : null);
    market.push({
      providerId: rep.providerId,
      displayName: peer?.displayName ?? `provider ${rep.providerId.slice(0, 8)}`,
      wallet: w,
      score: rep.score,
      accountable: rep.accountable,
      pricePerKiloToken: price,
      effectiveCost,
      settledCount: rep.settledCount,
      distinctPayers: rep.distinctPayers,
      unsettledCount: rep.unsettledCount,
      live: peer?.live ?? false,
      isSelf: Boolean(self.providerKey && rep.providerId === self.providerKey),
    });
  }
  // Live PAID peers with no reputation entry yet — surface them so the market shows the live field,
  // not just settled history (unknown providers: score from /peers if present, not yet accountable).
  for (const p of peers) {
    const w = lc(p.settlement?.recipient);
    if (!w || !p.pricePerKiloToken) continue;
    const known = [...market].some((m) => lc(m.wallet) === w);
    if (known) continue;
    market.push({
      providerId: "",
      displayName: p.displayName,
      wallet: p.settlement?.recipient ?? null,
      score: p.reputationScore ?? 0,
      accountable: false,
      pricePerKiloToken: p.pricePerKiloToken,
      effectiveCost: p.effectiveCost ?? null,
      settledCount: 0,
      distinctPayers: 0,
      unsettledCount: 0,
      live: p.live,
      isSelf: wallet != null && w === wallet,
    });
  }
  // Accountable + cheaper-effective-cost first; self sinks to the bottom (you don't buy from yourself).
  market.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return (a.effectiveCost ?? Infinity) - (b.effectiveCost ?? Infinity);
  });

  // ── My ledger: receipts where this device is the payee (earn) or payer (spend). ──
  const ledger: LedgerReceipt[] = [];
  for (const r of receipts) {
    if (!wallet) break;
    const isEarn = lc(r.providerAddress) === wallet;
    const isSpend = lc(r.payerAddress) === wallet;
    if (!isEarn && !isSpend) continue;
    ledger.push({
      sessionId: r.sessionId,
      alias: r.alias,
      tokens: r.actualTokens,
      amount: r.actualAmount,
      asset: r.asset,
      txHash: r.txHash,
      status: r.status,
      direction: isEarn ? "earn" : isSpend ? "spend" : "other",
      counterparty: isEarn ? r.payerAddress : r.providerAddress,
      at: r.settledAt ?? r.completedAt,
    });
  }
  ledger.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); // newest first

  // Totals + cumulative series over SETTLED receipts, time-ordered (oldest→newest) for the sparklines.
  const settled = ledger.filter((r) => r.status === "settled" && r.txHash);
  const earned = settled.filter((r) => r.direction === "earn").reduce((s, r) => s + r.amount, 0);
  const spent = settled.filter((r) => r.direction === "spend").reduce((s, r) => s + r.amount, 0);
  const chrono = [...settled].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const earnedSeries: number[] = [];
  const spentSeries: number[] = [];
  let ce = 0;
  let cs = 0;
  for (const r of chrono) {
    if (r.direction === "earn") ce += r.amount;
    if (r.direction === "spend") cs += r.amount;
    earnedSeries.push(ce);
    spentSeries.push(cs);
  }

  const asset = receipts[0]?.asset ?? peers.find((p) => p.settlement?.asset)?.settlement?.asset ?? "USDT0";
  const networkId = receipts[0]?.networkId ?? peers.find((p) => p.settlement?.networkId)?.settlement?.networkId ?? null;

  return { wallet: self.wallet, asset, networkId, earned, spent, net: earned - spent, settledCount: settled.length, earnedSeries, spentSeries, market, receipts: ledger };
}
