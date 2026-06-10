/**
 * Reputation scoring — PURE policy, no I/O (mirrors spend-policy.ts / metered.ts discipline; tested by
 * scripts/smoke-reputation.ts). Phase 3 of the agent-economy-incentives spec.
 *
 * Inputs are things that ALREADY exist and replicate (no new consensus):
 *   - settled receipts from the CRDT MeshGraph (`graph.receipts()`), counted ONLY when
 *     status==="settled" && txHash!=="" (Phase 4 adds on-chain txHash verification).
 *   - this device's own local observations (from hypha.jsonl): per-completion success + TTFB.
 *
 * The credibility centerpiece is `distinctPayers` weighting: a provider that earns all its volume
 * from ONE payer (classic self-deal / wash trade) is heavily discounted, and each (payer→provider)
 * pair is capped — so a provider can't lift its own score by paying itself in a loop. Score is
 * per-consumer-LOCAL (each device scores from what it sees); the inputs are replicated, the scoring is not.
 */

/** A settled receipt, structurally (maps from SessionSettlementReceipt). */
export interface ReceiptLike {
  providerId: string;
  payerAddress: string;
  status: string;
  txHash: string;
  actualAmount: number;
  /** The provider's payout wallet that received settlement (== receipt.providerAddress). Phase 4. */
  providerAddress?: string;
  /**
   * Phase 4 — on-chain verification verdict, set by `ReputationStore.setReceipts` via the injected
   * `verifyReceipt` dep. `undefined` (the default everywhere outside the Phase-4 path) means "trust
   * status+txHash as before" so the pre-Phase-4 scoring is byte-identical; `false` means the tx did
   * NOT move the asset on-chain → the receipt is excluded from volume (the centerpiece anti-forgery).
   */
  verified?: boolean;
}

/** One local observation of a completion served by a provider (from this device's audit log). */
export interface ProviderObservation {
  providerId: string;
  ok: boolean;
  ttftMs?: number;
}

export interface ReputationOpts {
  /** Max settled receipts from a single payer that count toward a provider's volume (anti-wash). Default 3. */
  perPayerCap?: number;
  /** Distinct payers needed for full credibility (self-deal floor below this). Default 3. */
  credibilityTarget?: number;
  /** TTFB (ms) treated as "good" (≤ this → full latency score). Default 1500. */
  goodTtftMs?: number;
  /** Effective-cost quality floor so a brand-new/low-quality provider isn't divided by ~0. Default 0.05. */
  qualityFloor?: number;
}

/**
 * Phase 4 — costly-identity accountability. INERT by default (`enabled` falsy) so pre-Phase-4 scoring
 * is byte-identical. When enabled, a provider's quality is multiplied by:
 *   - an accountability factor: full (1) only if the provider has a valid wallet↔key BINDING
 *     (`boundProviders`) AND at least one ON-CHAIN-verified settled receipt; else `floor` (demoted,
 *     not zeroed — it still competes). This makes faking reputation cost real money + a real wallet.
 *   - a slashing-lite factor: settled / (settled + unsettled) — providers carrying unsettled
 *     ("retrying"/"closed") receipts are demoted (economic slashing of future revenue, no on-chain bond).
 */
export interface AccountabilityOpts {
  enabled?: boolean;
  /** Provider keys whose advertised payee is wallet↔key bound (identityProof recovered to the payee). */
  boundProviders?: ReadonlySet<string>;
  /** Quality multiplier for an unbound/unverified provider. Default 0.1 (floored, still routable). */
  floor?: number;
}

export interface ProviderReputation {
  providerId: string;
  settledCount: number;
  distinctPayers: number;
  /** Settled receipt count after per-payer capping (the wash-resistant volume signal). */
  weightedVolume: number;
  /** Fraction of local observations that succeeded (1 if none seen). */
  successRate: number;
  avgTtftMs: number | null;
  /** 0..1 — reliability × distinct-payer credibility × latency × (Phase-4 accountability × slash). */
  quality: number;
  /** Headline score = weightedVolume × quality. Higher = more trusted. */
  score: number;
  /**
   * Phase 4 — true when the provider is wallet↔key bound AND has ≥1 on-chain-verified receipt. When
   * accountability is disabled this is `true` (no opinion). Surfaced on `/peers` + `GET /reputation`.
   */
  accountable: boolean;
  /** Receipts this provider is carrying that did NOT settle on-chain (retrying/closed/settled-without-txHash). */
  unsettledCount: number;
}

const DEFAULTS: Required<ReputationOpts> = { perPayerCap: 3, credibilityTarget: 3, goodTtftMs: 1500, qualityFloor: 0.05 };
const ACCOUNTABILITY_FLOOR = 0.1;

/** Compute per-provider reputation from settled receipts + local observations. Pure + deterministic. */
export function computeReputation(
  receipts: readonly ReceiptLike[],
  observations: readonly ProviderObservation[],
  opts: ReputationOpts = {},
  accountability: AccountabilityOpts = {},
): Map<string, ProviderReputation> {
  const { perPayerCap, credibilityTarget, goodTtftMs } = { ...DEFAULTS, ...opts };
  const acctEnabled = Boolean(accountability.enabled);
  const acctFloor = accountability.floor ?? ACCOUNTABILITY_FLOOR;

  // Group settled receipts by provider → payer → count. A receipt counts only when genuinely settled
  // (status + txHash) AND, under Phase 4, not on-chain-DISPROVEN (`verified === false` → forged/unpaid).
  const byProvider = new Map<string, Map<string, number>>();
  // Phase-4 slashing-lite: receipts a provider is carrying that did NOT settle on-chain.
  const unsettledByProvider = new Map<string, number>();
  for (const r of receipts) {
    if (r.status === "settled" && r.txHash && r.verified !== false) {
      let payers = byProvider.get(r.providerId);
      if (!payers) byProvider.set(r.providerId, (payers = new Map()));
      payers.set(r.payerAddress, (payers.get(r.payerAddress) ?? 0) + 1);
    } else if (r.status === "retrying" || r.status === "closed" || (r.status === "settled" && !r.txHash) || r.verified === false) {
      unsettledByProvider.set(r.providerId, (unsettledByProvider.get(r.providerId) ?? 0) + 1);
    }
  }

  // Local observations by provider.
  const obs = new Map<string, { ok: number; total: number; ttftSum: number; ttftN: number }>();
  for (const o of observations) {
    const e = obs.get(o.providerId) ?? { ok: 0, total: 0, ttftSum: 0, ttftN: 0 };
    e.total++;
    if (o.ok) e.ok++;
    if (typeof o.ttftMs === "number" && o.ttftMs >= 0) { e.ttftSum += o.ttftMs; e.ttftN++; }
    obs.set(o.providerId, e);
  }

  const out = new Map<string, ProviderReputation>();
  // Union: settled-receipt providers + observed providers. Under Phase 4 also surface providers carrying
  // ONLY unsettled receipts so routing can demote them (kept out of the disabled path → byte-identical).
  const providers = new Set<string>([...byProvider.keys(), ...obs.keys(), ...(acctEnabled ? unsettledByProvider.keys() : [])]);
  for (const providerId of providers) {
    const payers = byProvider.get(providerId) ?? new Map<string, number>();
    let settledCount = 0;
    let weightedVolume = 0;
    for (const [, count] of payers) {
      settledCount += count;
      weightedVolume += Math.min(count, perPayerCap); // cap each payer's contribution → wash-resistant
    }
    const distinctPayers = payers.size;
    const unsettledCount = unsettledByProvider.get(providerId) ?? 0;
    const e = obs.get(providerId);
    const successRate = e && e.total > 0 ? e.ok / e.total : 1;
    const avgTtftMs = e && e.ttftN > 0 ? e.ttftSum / e.ttftN : null;
    // Credibility: needs ≥ credibilityTarget distinct payers for full trust (self-deal floor).
    const credibility = Math.min(1, distinctPayers / credibilityTarget);
    // Latency: ≤ goodTtftMs → 1, degrading toward 0 by ~4× goodTtftMs.
    const latency = avgTtftMs == null ? 1 : Math.max(0, Math.min(1, 1 - (avgTtftMs - goodTtftMs) / (3 * goodTtftMs)));
    let quality = Math.max(0, Math.min(1, successRate * credibility * latency));
    // Phase 4 — accountability × slashing-lite. INERT when disabled (factor 1 → byte-identical scoring).
    let accountable = true;
    if (acctEnabled) {
      accountable = (accountability.boundProviders?.has(providerId) ?? false) && weightedVolume > 0;
      const slash = settledCount + unsettledCount > 0 ? settledCount / (settledCount + unsettledCount) : 1;
      quality = Math.max(0, Math.min(1, quality * (accountable ? 1 : acctFloor) * slash));
    }
    const score = weightedVolume * quality;
    out.set(providerId, { providerId, settledCount, distinctPayers, weightedVolume, successRate, avgTtftMs, quality, score, accountable, unsettledCount });
  }
  return out;
}

/**
 * Routing tie-break for PAID providers: price per quality. Lower = preferred. A high-quality provider
 * is effectively cheaper than a flaky one at the same price; an unknown provider (no reputation) gets
 * the quality floor so it still competes but isn't blindly trusted.
 */
export function effectiveCost(pricePerKiloToken: number, rep: ProviderReputation | undefined, opts: ReputationOpts = {}): number {
  const floor = opts.qualityFloor ?? DEFAULTS.qualityFloor;
  const quality = Math.max(rep?.quality ?? floor, floor);
  return pricePerKiloToken / quality;
}

/**
 * Live reputation over the two inputs that already replicate / accrue locally: settled receipts
 * (from `graph.receipts()`, refreshed) + this device's own completion observations. Scores are
 * recomputed lazily and cached until an input changes. Read-only — never modifies settlement state.
 * Implements the `ReputationRanker` the warm pool consumes (`effectiveCost`/`score` by provider key).
 */
export interface ReputationStoreOpts {
  maxObservations?: number;
  reputationOpts?: ReputationOpts;
  /**
   * Phase 4 — on-chain receipt verification. When injected, `setReceipts` checks every settled receipt's
   * txHash on-chain and annotates `verified`; a disproven (forged / never-paid) receipt is excluded from
   * volume. Absent → Phase 4 is OFF and scoring is byte-identical to Phase 3. Cached by txHash (immutable).
   */
  verifyReceipt?: (r: ReceiptLike) => Promise<boolean>;
  /** Phase 4 — true when this provider's advertised payee is wallet↔key bound (identityProof valid). */
  isBound?: (providerId: string) => boolean;
  /** Quality floor for unbound/unverified providers (default 0.1). */
  accountabilityFloor?: number;
}

export class ReputationStore {
  private receipts: readonly ReceiptLike[] = [];
  private readonly observations: ProviderObservation[] = [];
  private cache: Map<string, ProviderReputation> | null = null;
  private readonly maxObservations: number;
  private readonly opts: ReputationOpts;
  private readonly verifyReceipt?: (r: ReceiptLike) => Promise<boolean>;
  private readonly isBound?: (providerId: string) => boolean;
  private readonly accountabilityFloor?: number;
  /** txHash → on-chain verdict; txHashes are immutable so a verified receipt is cached permanently. */
  private readonly verifyCache = new Map<string, boolean>();

  constructor(opts: ReputationStoreOpts = {}) {
    this.maxObservations = opts.maxObservations ?? 1000;
    this.opts = opts.reputationOpts ?? {};
    if (opts.verifyReceipt) this.verifyReceipt = opts.verifyReceipt;
    if (opts.isBound) this.isBound = opts.isBound;
    if (opts.accountabilityFloor != null) this.accountabilityFloor = opts.accountabilityFloor;
  }

  /**
   * Replace the settled-receipt snapshot (call on a timer from `graph.receipts()`). When a Phase-4
   * `verifyReceipt` dep is injected, this is the async on-chain verification layer: each settled
   * receipt's tx is confirmed on-chain (cached by txHash) and annotated before scoring; without the
   * dep it just stores the snapshot (byte-identical Phase-3 behaviour).
   */
  async setReceipts(receipts: readonly ReceiptLike[]): Promise<void> {
    if (this.verifyReceipt) {
      const annotated: ReceiptLike[] = [];
      for (const r of receipts) {
        if (r.status === "settled" && r.txHash) {
          // Cache only CONFIRMED txs (immutable once true); a `false` may be a not-yet-mined/replicated
          // tx, so it is re-checked next tick rather than cached as a permanent disproof.
          let v = this.verifyCache.get(r.txHash) ?? false;
          if (!v) {
            v = await this.verifyReceipt(r).catch(() => false);
            if (v) this.verifyCache.set(r.txHash, true);
          }
          annotated.push(r.verified === v ? r : { ...r, verified: v });
        } else {
          annotated.push(r);
        }
      }
      this.receipts = annotated;
    } else {
      this.receipts = receipts;
    }
    this.cache = null;
  }

  /** Phase-4 accountability inputs for the pure scorer; INERT (`{}`) when no verifier is injected. */
  private accountabilityOpts(): AccountabilityOpts {
    if (!this.verifyReceipt) return {};
    const bound = new Set<string>();
    const mark = (id: string): void => { if (!this.isBound || this.isBound(id)) bound.add(id); };
    for (const r of this.receipts) mark(r.providerId);
    for (const o of this.observations) mark(o.providerId);
    const out: AccountabilityOpts = { enabled: true, boundProviders: bound };
    if (this.accountabilityFloor != null) out.floor = this.accountabilityFloor;
    return out;
  }

  /** Record one local observation of a delegated completion (ring-buffered). */
  recordObservation(o: ProviderObservation): void {
    this.observations.push(o);
    if (this.observations.length > this.maxObservations) this.observations.splice(0, this.observations.length - this.maxObservations);
    this.cache = null;
  }

  reputation(): Map<string, ProviderReputation> {
    if (!this.cache) this.cache = computeReputation(this.receipts, this.observations, this.opts, this.accountabilityOpts());
    return this.cache;
  }

  scoreFor(providerId: string): ProviderReputation | undefined {
    return this.reputation().get(providerId);
  }

  // ── ReputationRanker (consumed by the warm pool) ──────────────────────────────────────────────
  /** Routing tie-break for a paid provider: price ÷ quality (lower = preferred). */
  effectiveCost(providerId: string, pricePerKiloToken: number): number {
    return effectiveCost(pricePerKiloToken, this.reputation().get(providerId), this.opts);
  }
  /** Headline score for `/peers` display, or undefined if unseen. */
  score(providerId: string): number | undefined {
    return this.reputation().get(providerId)?.score;
  }

  /** Full snapshot for `GET /reputation` (sorted best-first). */
  snapshot(): ProviderReputation[] {
    return [...this.reputation().values()].sort((a, b) => b.score - a.score);
  }
}
