/**
 * Bounded-signing safety layer for the Machine Economy (v2 / post-submission). Spec §10, Hard Rule 6.
 *
 * The danger: an LLM holding a signing tool + untrusted input is a drain-the-wallet machine, and
 * on-chain transfers are IRREVERSIBLE. The innovation is doing autonomous payment SAFELY. This module
 * is the guardrail — PURE policy, no chain, no money — so it is exhaustively testable:
 *
 *   - The agent NEVER calls `send(to, amount)`. It calls `settle_inference(provider, tokens)`. The
 *     AMOUNT is computed from a price sheet (the protocol/x402 invoice), never the model's choice;
 *     the PAYEE is the provider it actually received tokens from, never a model-supplied address.
 *   - Every spend is checked against caps ENFORCED HERE (not by trusting the model): per-tx,
 *     rolling per-hour, rolling per-counterparty, and a hot-wallet FLOAT (the most the agent can
 *     ever lose; top-ups are human-gated).
 *   - Counterparties are ALLOW-LISTED — you only pay a provider you actually delegated to.
 *
 * The real on-chain settlement (x402 on Plasma) is injected as a `pay()` callback, so this layer is
 * chain-agnostic and proven without moving a cent. Firewall (§4): this pays for delivered COMPUTE —
 * never for alerts/corroboration (no panic-mining). Proven by scripts/smoke-spend-policy.ts.
 */

/** Hot-wallet spend caps. All amounts in the settlement unit (e.g. USDt; integers = micro-units recommended). */
export interface SpendLimits {
  /** Max for a single settlement. */
  maxPerTx: number;
  /** Rolling 1-hour cap across ALL counterparties. */
  maxPerHour: number;
  /** Rolling 1-hour cap for any ONE counterparty (collusion bound). */
  maxPerCounterparty: number;
}

/** The price the PROTOCOL sets (an x402 invoice / agreed sheet) — never the model. */
export interface PriceSheet {
  /** Units per 1000 delivered tokens. */
  perKiloToken: number;
}

/** What the agent may ask to settle: a provider it delegated to + the tokens IT delivered (from the audit log). */
export interface SettlementRequest {
  provider: string;
  tokens: number;
}

/** A pre-authorized spend CAP for one in-flight compute run (the x402 `upto` budget). */
export interface BudgetRequest {
  provider: string;
  amount: number;
}

export type SettlementDecision =
  | { ok: true; amount: number; provider: string }
  | { ok: false; reason: string };

interface LedgerEntry {
  provider: string;
  amount: number;
  ts: number;
}

const sum = (xs: LedgerEntry[]): number => xs.reduce((s, e) => s + e.amount, 0);

export type BudgetDecision =
  | { ok: true; amount: number; provider: string }
  | { ok: false; reason: string };

/** Decide whether a spend CAP may be reserved now (pre-compute budget authorization). */
export function authorizeBudget(
  req: BudgetRequest,
  limits: SpendLimits,
  allowlist: ReadonlySet<string>,
  floatBalance: number,
  recent: readonly LedgerEntry[],
  now: number,
): BudgetDecision {
  if (!Number.isFinite(req.amount) || req.amount <= 0) return { ok: false, reason: "invalid budget" };
  if (!allowlist.has(req.provider)) return { ok: false, reason: "counterparty not allow-listed" };
  if (req.amount > limits.maxPerTx) return { ok: false, reason: `exceeds per-tx cap (${req.amount} > ${limits.maxPerTx})` };
  if (req.amount > floatBalance) return { ok: false, reason: "exceeds hot-wallet float" };
  const windowStart = now - 3_600_000;
  const inWindow = recent.filter((e) => e.ts >= windowStart);
  if (sum(inWindow) + req.amount > limits.maxPerHour) return { ok: false, reason: "exceeds hourly cap" };
  const cp = inWindow.filter((e) => e.provider === req.provider);
  if (sum(cp) + req.amount > limits.maxPerCounterparty) return { ok: false, reason: "exceeds per-counterparty cap" };
  return { ok: true, amount: req.amount, provider: req.provider };
}

/**
 * Decide whether a settlement is authorized — PURE. Computes the amount from the price sheet (not the
 * request, not the model), then enforces allow-list + per-tx + float + hourly + per-counterparty caps.
 * `floatBalance` is the remaining hot-wallet float; `recent` is settlements in the trailing window.
 */
export function authorizeSettlement(
  req: SettlementRequest,
  price: PriceSheet,
  limits: SpendLimits,
  allowlist: ReadonlySet<string>,
  floatBalance: number,
  recent: readonly LedgerEntry[],
  now: number,
): SettlementDecision {
  if (!Number.isFinite(req.tokens) || req.tokens <= 0) return { ok: false, reason: "no tokens delivered" };
  if (!allowlist.has(req.provider)) return { ok: false, reason: "counterparty not allow-listed" };
  // Amount is derived from the protocol price + delivered tokens — the model cannot set it.
  const amount = Math.ceil((req.tokens / 1000) * price.perKiloToken);
  if (amount <= 0) return { ok: false, reason: "computed amount is zero" };
  if (amount > limits.maxPerTx) return { ok: false, reason: `exceeds per-tx cap (${amount} > ${limits.maxPerTx})` };
  if (amount > floatBalance) return { ok: false, reason: "exceeds hot-wallet float" };
  const windowStart = now - 3_600_000;
  const inWindow = recent.filter((e) => e.ts >= windowStart);
  if (sum(inWindow) + amount > limits.maxPerHour) return { ok: false, reason: "exceeds hourly cap" };
  const cp = inWindow.filter((e) => e.provider === req.provider);
  if (sum(cp) + amount > limits.maxPerCounterparty) return { ok: false, reason: "exceeds per-counterparty cap" };
  return { ok: true, amount, provider: req.provider };
}

/** The actual irreversible transfer — injected, so the guard is chain-agnostic (x402/Plasma later). */
export type PayFn = (provider: string, amount: number) => Promise<{ txRef: string }>;
export type PayAuthorizedFn<Auth> = (provider: string, amount: number, auth: Auth) => Promise<{ txRef: string }>;

export interface BudgetReservation {
  id: string;
  provider: string;
  amount: number;
  ts: number;
}

/**
 * The settle_inference TOOL the agent is given — a SpendGuard, NOT a raw `send`. It holds the float +
 * the trailing ledger, authorizes against the caps, and only then calls the injected `pay()`. The
 * model can pass any `provider`/`tokens` (incl. prompt-injected garbage); the guard is what keeps the
 * blast radius to at most the float, and pays only allow-listed counterparties at protocol prices.
 */
export class SpendGuard {
  private floatBalance: number;
  private readonly ledger: LedgerEntry[] = [];
  private readonly reservations = new Map<string, BudgetReservation>();

  constructor(
    private readonly limits: SpendLimits,
    private readonly price: PriceSheet,
    private readonly allowlist: Set<string>,
    initialFloat: number,
    private readonly pay: PayFn,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.floatBalance = initialFloat;
  }

  get float(): number {
    return this.floatBalance;
  }
  /** Allow-list a counterparty you actually delegated to (called by the consumer path, never the model). */
  allow(provider: string): void {
    this.allowlist.add(provider);
  }

  /** Authorize a settlement WITHOUT paying (dry-run for the UI / preflight). */
  authorize(req: SettlementRequest): SettlementDecision {
    return authorizeSettlement(req, this.price, this.limits, this.allowlist, this.floatBalance, this.ledger, this.now());
  }

  /** Reserve a pre-compute spend CAP (used by x402 `upto` authorization). */
  reserveBudget(req: BudgetRequest): BudgetDecision & { reservationId?: string } {
    const recent = [
      ...this.ledger,
      ...[...this.reservations.values()].map((r) => ({ provider: r.provider, amount: r.amount, ts: r.ts })),
    ];
    const decision = authorizeBudget(req, this.limits, this.allowlist, this.floatBalance, recent, this.now());
    if (!decision.ok) return decision;
    const reservation: BudgetReservation = {
      id: `${decision.provider}:${this.now()}:${Math.random().toString(36).slice(2, 10)}`,
      provider: decision.provider,
      amount: decision.amount,
      ts: this.now(),
    };
    this.floatBalance -= reservation.amount;
    this.reservations.set(reservation.id, reservation);
    return { ...decision, reservationId: reservation.id };
  }

  /** Release an unused or failed budget reservation in full. */
  releaseBudget(reservationId: string): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return false;
    this.reservations.delete(reservationId);
    this.floatBalance += reservation.amount;
    return true;
  }

  /**
   * Capture an in-flight budget reservation at the ACTUAL settled amount.
   * The actual amount must be <= the reserved cap; the difference is refunded immediately.
   */
  async captureBudget<Auth>(
    reservationId: string,
    actualAmount: number,
    payAuthorized: PayAuthorizedFn<Auth>,
    auth: Auth,
  ): Promise<SettlementDecision & { txRef?: string }> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return { ok: false, reason: "unknown budget reservation" };
    if (!Number.isFinite(actualAmount) || actualAmount < 0) return { ok: false, reason: "invalid actual amount" };
    if (actualAmount > reservation.amount) return { ok: false, reason: "actual amount exceeds reserved budget" };
    this.reservations.delete(reservationId);
    this.floatBalance += reservation.amount - actualAmount;
    if (actualAmount === 0) return { ok: true, amount: 0, provider: reservation.provider, txRef: "" };
    const entry: LedgerEntry = { provider: reservation.provider, amount: actualAmount, ts: reservation.ts };
    this.ledger.push(entry);
    try {
      const { txRef } = await payAuthorized(reservation.provider, actualAmount, auth);
      return { ok: true, amount: actualAmount, provider: reservation.provider, txRef };
    } catch (err) {
      this.floatBalance += actualAmount;
      const i = this.ledger.indexOf(entry);
      if (i >= 0) this.ledger.splice(i, 1);
      return { ok: false, reason: `settlement failed (refunded): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * The bounded `settle_inference` the agent calls. Authorizes; on approval debits the float, records
   * the ledger, and performs the injected on-chain pay. Rejections never touch money. A failed `pay()`
   * refunds the float + drops the ledger entry (no phantom spend).
   */
  async settleInference(req: SettlementRequest): Promise<SettlementDecision & { txRef?: string }> {
    const decision = this.authorize(req);
    if (!decision.ok) return decision;
    const entry: LedgerEntry = { provider: decision.provider, amount: decision.amount, ts: this.now() };
    this.floatBalance -= decision.amount;
    this.ledger.push(entry);
    try {
      const { txRef } = await this.pay(decision.provider, decision.amount);
      return { ...decision, txRef };
    } catch (err) {
      this.floatBalance += decision.amount;
      const i = this.ledger.indexOf(entry);
      if (i >= 0) this.ledger.splice(i, 1);
      return { ok: false, reason: `settlement failed (refunded): ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
