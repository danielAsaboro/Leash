import { randomUUID } from "node:crypto";
import type { AuditLog, SessionSettlementReceipt, Visibility } from "@mycelium/shared";
import { localChatAliases } from "./catalog.ts";
import { signProviderPayload, digestAuthorization, type ActiveSessionRecord, type AdvanceAuthorizationRequest, type AdvanceAuthorizationResponse, type AuthorizationRung, type BlockedPayerRecord, type ClosePaidSessionRequest, type OpenPaidSessionRequest, type PaidSessionGrant, type PaidSessionQuote, type PendingBudgetVerification, type QuoteBudgetRequest, type UnsettledReceiptRecord, type VerifyBudgetRequest, type VerifyBudgetResponse } from "./economy-types.ts";
import type { PlasmaSettlementService, PlasmaVerifiedBudget } from "./plasma-settlement.ts";
import { appendRung, initMeteredState, isIdleExpired, rungToSettle, settleTokensAtClose, settleTokensAtCutoff } from "./metered.ts";
import { ProviderEconomyStore } from "./provider-economy-store.ts";

interface MeshParticipant {
  visibility: Visibility;
  providerWriterKey: string;
  consumerPublicKey?: string;
}

export interface ProviderEconomyDeps {
  seed: string;
  audit: AuditLog;
  storeDir: string;
  plasma: PlasmaSettlementService;
  providerPublicKey: () => string | null;
  resolveMeshParticipant(meshId: string, consumerWriterKey: string): Promise<MeshParticipant | null>;
  publishReceipt(meshId: string, receipt: SessionSettlementReceipt): Promise<void>;
  retryIntervalMs?: number;
  /** Metered (pay-as-you-go) config. Absent/disabled = legacy single-settle close path only. */
  metered?: { enabled: boolean; chunkTokens: number; advanceWindowMs: number };
  /**
   * Best-effort hook to drop a consumer from the firewall when its metered session is force-settled
   * by the watchdog. The money backstop (settle the authorized cap) works WITHOUT this; the firewall
   * cut depends on Phase 1 (does the SDK swarm teardown actually revoke?), so it stays optional.
   */
  revokeConsumer?: (consumerPublicKey: string) => void | Promise<void>;
}

const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

export class ProviderEconomyService {
  private readonly aliases = new Map(localChatAliases().map((a) => [a.alias, a.modelSrc]));
  private readonly store: ProviderEconomyStore;
  private readonly pending = new Map<string, PendingBudgetVerification>();
  private readonly pendingByDigest = new Map<string, string>();
  /** Sessions with a close in flight — a second close (consumer recovery/replay) must not race the settle. */
  private readonly closing = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: ProviderEconomyDeps) {
    this.store = new ProviderEconomyStore(deps.storeDir);
    const interval = deps.retryIntervalMs ?? RETRY_BASE_MS;
    this.timer = setInterval(() => {
      void this.retryUnsettled();
      void this.sweepMeteredIdle();
    }, interval);
    this.timer.unref?.();
    void this.retryUnsettled();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  snapshot(): { activeSessions: number; unsettledReceipts: number; blockedPayers: number; settledReceipts: number } {
    return {
      activeSessions: this.store.activeSessionCount(),
      unsettledReceipts: this.store.listUnsettled().length,
      blockedPayers: this.store.listBlockedPayers().length,
      settledReceipts: this.store.listSettled().length,
    };
  }

  async quoteBudget(req: QuoteBudgetRequest): Promise<PaidSessionQuote> {
    const providerPublicKey = this.deps.providerPublicKey();
    if (!providerPublicKey) throw new Error("provider public key unavailable");
    if (req.providerPublicKey !== providerPublicKey) throw new Error("provider public key mismatch");
    const mesh = await this.validateMeshBinding(req.meshId, req.consumerWriterKey, req.consumerPublicKey);
    const resolvedModelSrc = this.aliases.get(req.alias);
    if (!resolvedModelSrc) throw new Error(`provider does not serve alias "${req.alias}"`);
    if (req.modelSrc && req.modelSrc !== resolvedModelSrc) throw new Error("modelSrc does not match the provider alias target");
    const endpoint = this.deps.plasma.payoutEndpoint();
    if (!endpoint?.x402) throw new Error("provider has no x402-enabled Plasma payout rail");
    const maxAmount = Math.min(
      Math.max(1, Math.floor(req.requestedBudget ?? this.deps.plasma.maxBudget())),
      this.deps.plasma.maxBudget(),
    );
    const quote: PaidSessionQuote = {
      quoteId: randomUUID(),
      meshId: req.meshId,
      alias: req.alias,
      modelSrc: resolvedModelSrc,
      maxAmount,
      expiry: new Date(Date.now() + endpoint.x402.maxTimeoutSeconds * 1000).toISOString(),
      x402Version: 2,
      scheme: "upto",
      network: "plasma",
      networkId: endpoint.networkId,
      asset: endpoint.asset,
      payTo: endpoint.recipient,
      facilitator: endpoint.x402.facilitator,
      pricePerKiloToken: endpoint.x402.pricePerKiloToken,
      ...(this.deps.metered?.enabled
        ? { meteredChunkTokens: this.deps.metered.chunkTokens, meteredChunkAmount: this.deps.plasma.amountForTokens(this.deps.metered.chunkTokens) }
        : {}),
      providerWriterKey: mesh.providerWriterKey,
      providerPublicKey,
    };
    this.deps.audit.record({
      event: "note",
      extra: { role: "economy", phase: "quote_budget", meshId: req.meshId, alias: req.alias, maxAmount, consumer: req.consumerWriterKey, provider: providerPublicKey.slice(0, 16) },
    });
    return quote;
  }

  async verifyBudget(req: VerifyBudgetRequest): Promise<VerifyBudgetResponse> {
    this.assertQuoteLive(req.quote);
    const payerBlock = this.store.getBlockedPayer(req.payerAddress);
    if (payerBlock) throw new Error(`payer is blocked until unsettled receipts clear (${payerBlock.receiptIds.join(",")})`);
    const providerPublicKey = this.deps.providerPublicKey();
    if (!providerPublicKey) throw new Error("provider public key unavailable");
    if (req.providerPublicKey !== providerPublicKey || req.quote.providerPublicKey !== providerPublicKey) throw new Error("provider public key mismatch");
    const mesh = await this.validateMeshBinding(req.quote.meshId, req.consumerWriterKey, req.consumerPublicKey);
    if (req.providerWriterKey !== mesh.providerWriterKey || req.quote.providerWriterKey !== mesh.providerWriterKey) {
      throw new Error("provider writer key mismatch");
    }
    if (req.quote.modelSrc !== this.aliases.get(req.quote.alias)) {
      throw new Error("quote alias/model binding is invalid");
    }
    const authorizationDigest = digestAuthorization({
      quote: req.quote,
      paymentPayload: req.paymentPayload,
      accepted: req.accepted,
      consumerWriterKey: req.consumerWriterKey,
      consumerPublicKey: req.consumerPublicKey,
      payerAddress: req.payerAddress,
      nonce: req.nonce,
    });
    if (this.store.authorizationUsed(authorizationDigest) || this.pendingByDigest.has(authorizationDigest)) {
      throw new Error("authorization replay rejected");
    }
    const endpoint = this.deps.plasma.payoutEndpoint();
    if (!endpoint) throw new Error("provider has no Plasma payout endpoint");
    // Metered open: the consumer signs the TIER-0 chunk cap (not the full ceiling). Bind the quote's
    // advertised chunk to THIS provider's config so a tampered quote can't shift the accounting.
    const metered = Boolean(this.deps.metered?.enabled && req.quote.meteredChunkTokens != null);
    if (this.deps.metered?.enabled && req.quote.meteredChunkTokens !== this.deps.metered.chunkTokens) {
      throw new Error("metered chunk size does not match the provider configuration");
    }
    const verifyAmount = metered ? this.deps.plasma.amountForTokens(this.deps.metered!.chunkTokens) : req.quote.maxAmount;
    const verified = await this.deps.plasma.verifyBudget(
      providerPublicKey,
      verifyAmount,
      endpoint,
      req.paymentPayload,
      req.accepted,
    );
    if (!verified.ok) throw new Error(verified.reason);
    const verificationId = randomUUID();
    const pending: PendingBudgetVerification = {
      verificationId,
      quote: req.quote,
      payerAddress: req.payerAddress,
      consumerWriterKey: req.consumerWriterKey,
      consumerPublicKey: req.consumerPublicKey,
      providerWriterKey: req.providerWriterKey,
      providerPublicKey: req.providerPublicKey,
      nonce: req.nonce,
      authorizationDigest,
      verified: verified.verification,
    };
    this.pending.set(verificationId, pending);
    this.pendingByDigest.set(authorizationDigest, verificationId);
    this.deps.audit.record({
      event: "note",
      extra: { role: "economy", phase: "verify_budget", meshId: req.quote.meshId, sessionAlias: req.quote.alias, verificationId, payer: req.payerAddress },
    });
    return { verificationId, authorizationDigest };
  }

  async openPaidSession(req: OpenPaidSessionRequest): Promise<PaidSessionGrant> {
    this.assertQuoteLive(req.quote);
    const pending = this.pending.get(req.verificationId);
    if (!pending) throw new Error("verification expired or missing");
    if (pending.authorizationDigest && this.store.authorizationUsed(pending.authorizationDigest)) {
      throw new Error("authorization replay rejected");
    }
    if (
      pending.quote.quoteId !== req.quote.quoteId ||
      pending.consumerWriterKey !== req.consumerWriterKey ||
      pending.consumerPublicKey !== req.consumerPublicKey ||
      pending.providerWriterKey !== req.providerWriterKey ||
      pending.providerPublicKey !== req.providerPublicKey ||
      pending.payerAddress !== req.payerAddress ||
      pending.nonce !== req.nonce
    ) {
      throw new Error("open_paid_session request does not match the verified budget");
    }
    const sessionId = randomUUID();
    const grantBase = {
      sessionId,
      meshId: pending.quote.meshId,
      consumerWriterKey: pending.consumerWriterKey,
      consumerPublicKey: pending.consumerPublicKey,
      providerWriterKey: pending.providerWriterKey,
      providerPublicKey: pending.providerPublicKey,
      alias: pending.quote.alias,
      modelSrc: pending.quote.modelSrc,
      maxAmount: pending.quote.maxAmount,
      expiry: pending.quote.expiry,
      x402Version: 2 as const,
      scheme: "upto" as const,
      networkId: pending.quote.networkId,
      payerAddress: pending.payerAddress,
      payTo: pending.quote.payTo,
      nonce: pending.nonce,
      authorizationDigest: pending.authorizationDigest,
    };
    const grant: PaidSessionGrant = {
      ...grantBase,
      providerSignature: signProviderPayload(this.deps.seed, grantBase),
    };
    const openedAt = new Date().toISOString();
    const record: ActiveSessionRecord = {
      grant,
      verified: pending.verified,
      recipient: pending.verified.recipient,
      openedAt,
    };
    // Metered (opt-in): the open IS tier-0 of the escalating ladder. acceptedThroughTokens starts at
    // chunkTokens (the cap the consumer signed at verify time); settleVerified is the hard backstop
    // that prevents charging more than that signature covers, so deriving tier-0 from config is safe.
    if (this.deps.metered?.enabled && pending.quote.meteredChunkTokens != null) {
      const cfg = { chunkTokens: this.deps.metered.chunkTokens, advanceWindowMs: this.deps.metered.advanceWindowMs };
      const tier0: AuthorizationRung = {
        tierIndex: 0,
        cumulativeTokens: cfg.chunkTokens,
        cumulativeAmount: this.deps.plasma.amountForTokens(cfg.chunkTokens),
        authorizationDigest: pending.authorizationDigest,
        verified: pending.verified,
        acceptedAt: openedAt,
      };
      record.metered = appendRung(initMeteredState(cfg, openedAt), tier0).state;
    }
    this.store.putActiveSession(record);
    this.store.markAuthorizationUsed(pending.authorizationDigest, sessionId);
    this.pending.delete(req.verificationId);
    this.pendingByDigest.delete(pending.authorizationDigest);
    this.deps.audit.record({
      event: "note",
      extra: { role: "economy", phase: "open_paid_session", meshId: grant.meshId, sessionId, alias: grant.alias, payer: grant.payerAddress },
    });
    return grant;
  }

  /**
   * Metered escalation: verify a FRESH Permit2 witness for a higher cumulative token cap and append
   * it to the session's ladder. Idempotent on (sessionId, tierIndex) — a re-sent advance returns the
   * current cap. Mirrors verifyBudget (same on-chain verify), but binds to an OPEN session and never
   * marks the authorization "used" (the ladder's tierIndex is the in-memory replay guard; the Permit2
   * nonce is the on-chain one). The cap can never exceed the session's quoted budget.
   */
  async advanceAuthorization(req: AdvanceAuthorizationRequest): Promise<AdvanceAuthorizationResponse> {
    const active = this.store.getActiveSession(req.sessionId);
    if (!active) throw new Error("session not found or already closed");
    if (!active.metered) throw new Error("session is not metered");
    if (this.closing.has(req.sessionId)) throw new Error("session is closing");
    if (
      active.grant.consumerWriterKey !== req.consumerWriterKey ||
      active.grant.consumerPublicKey !== req.consumerPublicKey ||
      active.grant.providerWriterKey !== req.providerWriterKey ||
      active.grant.providerPublicKey !== req.providerPublicKey
    ) {
      throw new Error("advance_authorization identity mismatch");
    }
    if (Date.parse(active.grant.expiry) <= Date.now()) throw new Error("session budget expired");
    const cumulativeTokens = Math.floor(req.cumulativeTokens);
    if (!(cumulativeTokens > 0)) throw new Error("advance cumulativeTokens must be positive");
    const cumulativeAmount = this.deps.plasma.amountForTokens(cumulativeTokens);
    if (cumulativeAmount > active.grant.maxAmount) throw new Error("advance exceeds the quoted session budget cap");

    // Idempotent fast-path: a rung already at this tier (re-sent advance) → return the current cap.
    const existing = active.metered.ladder.find((r) => r.tierIndex === req.tierIndex);
    if (existing) {
      return { sessionId: req.sessionId, tierIndex: req.tierIndex, acceptedThroughTokens: active.metered.acceptedThroughTokens };
    }

    const authorizationDigest = digestAuthorization({
      quote: {
        quoteId: `${active.grant.sessionId}:${req.tierIndex}`,
        meshId: active.grant.meshId,
        alias: active.grant.alias,
        modelSrc: active.grant.modelSrc,
        maxAmount: cumulativeAmount,
        providerPublicKey: active.grant.providerPublicKey,
        providerWriterKey: active.grant.providerWriterKey,
      },
      paymentPayload: req.paymentPayload,
      accepted: req.accepted,
      consumerWriterKey: req.consumerWriterKey,
      consumerPublicKey: req.consumerPublicKey,
      payerAddress: req.payerAddress,
      nonce: req.nonce,
    });
    const endpoint = this.deps.plasma.payoutEndpoint();
    if (!endpoint) throw new Error("provider has no Plasma payout endpoint");
    const verified = await this.deps.plasma.verifyBudget(active.grant.providerPublicKey, cumulativeAmount, endpoint, req.paymentPayload, req.accepted);
    if (!verified.ok) throw new Error(verified.reason);

    const rung: AuthorizationRung = {
      tierIndex: req.tierIndex,
      cumulativeTokens,
      cumulativeAmount,
      authorizationDigest,
      verified: verified.verification,
      acceptedAt: new Date().toISOString(),
    };
    const { state } = appendRung(active.metered, rung);
    active.metered = state;
    this.store.putActiveSession(active);
    this.deps.audit.record({
      event: "note",
      extra: { role: "economy", phase: "advance_authorization", sessionId: req.sessionId, tierIndex: req.tierIndex, acceptedThroughTokens: state.acceptedThroughTokens, cumulativeAmount },
    });
    return { sessionId: req.sessionId, tierIndex: req.tierIndex, acceptedThroughTokens: state.acceptedThroughTokens };
  }

  async closePaidSession(req: ClosePaidSessionRequest): Promise<SessionSettlementReceipt> {
    // Serialize per session: a slow settle (RPC outage) can outlive the consumer's close timeout,
    // and a duplicate close arriving meanwhile would zero-settle and remove the session while the
    // real settle is still running (provider loses the revenue — observed live 2026-06-10).
    if (this.closing.has(req.sessionId)) throw new Error("close already in progress for this session");
    this.closing.add(req.sessionId);
    try {
      return await this.closePaidSessionLocked(req);
    } finally {
      this.closing.delete(req.sessionId);
    }
  }

  private async closePaidSessionLocked(req: ClosePaidSessionRequest): Promise<SessionSettlementReceipt> {
    const active = this.store.getActiveSession(req.sessionId);
    if (!active) throw new Error("session not found or already closed");
    if (
      active.grant.consumerWriterKey !== req.consumerWriterKey ||
      active.grant.consumerPublicKey !== req.consumerPublicKey ||
      active.grant.providerWriterKey !== req.providerWriterKey ||
      active.grant.providerPublicKey !== req.providerPublicKey
    ) {
      throw new Error("close_paid_session identity mismatch");
    }
    // Metered: never charge more tokens than the consumer authorized, and settle the highest rung's
    // verified budget (its own Permit2 witness). Legacy: settle the single open budget at the
    // consumer-reported count (the proven path, unchanged).
    const actualTokens = active.metered
      ? settleTokensAtClose(active.metered, req.actualTokens)
      : Math.max(0, Math.floor(req.actualTokens));
    const verified = active.metered ? (rungToSettle(active.metered)?.verified ?? active.verified) : active.verified;
    return this.finalizeSettlement(active, actualTokens, verified, "close_paid_session");
  }

  /**
   * Settle one verified budget at `actualTokens`, then build + persist + publish the receipt. Shared
   * by the legacy close, the metered close, and the metered watchdog cutoff — so the retry/block
   * bookkeeping is identical for all three. `verified` is the budget whose Permit2 witness is settled
   * (the open budget legacy, the top rung metered) and is what an unsettled retry re-uses.
   */
  private async finalizeSettlement(
    active: ActiveSessionRecord,
    actualTokens: number,
    verified: PlasmaVerifiedBudget,
    phase: string,
  ): Promise<SessionSettlementReceipt> {
    const completedAt = new Date().toISOString();
    const actualAmount = this.deps.plasma.amountForTokens(actualTokens);
    const result = await this.deps.plasma.settleVerified(verified, actualAmount);
    const receipt = this.buildReceipt(active, {
      actualTokens,
      actualAmount: result.ok ? result.amount : actualAmount,
      completedAt,
      settledAt: result.ok ? new Date().toISOString() : null,
      status: result.ok ? "settled" : "retrying",
      txHash: result.ok ? result.txRef : "",
      failureReason: result.ok ? undefined : result.reason,
      retryCount: result.ok ? undefined : 1,
    });
    this.store.removeActiveSession(active.grant.sessionId);
    if (result.ok) {
      this.store.putSettled(receipt);
      this.clearBlockIfPossible(receipt.payerAddress);
    } else {
      const unsettled: UnsettledReceiptRecord = {
        receipt,
        verified,
        nextRetryAt: new Date(Date.now() + RETRY_BASE_MS).toISOString(),
      };
      this.store.putUnsettled(unsettled);
      this.blockPayer(receipt.payerAddress, receipt.sessionId, result.reason);
    }
    await this.publishReceipt(receipt);
    this.deps.audit.record({
      event: "note",
      extra: { role: "economy", phase, meshId: receipt.meshId, sessionId: receipt.sessionId, status: receipt.status, actualTokens, actualAmount: receipt.actualAmount, txHash: receipt.txHash, failureReason: receipt.failureReason },
    });
    return receipt;
  }

  /**
   * Watchdog: force-settle metered sessions idle past advanceWindowMs (the consumer stopped advancing
   * — abandoned or stalled). Settles the full AUTHORIZED cap (the consumer signed for it) as the
   * abandoned-session backstop, then best-effort revokes the consumer. Swept on the retry interval so
   * it survives a provider restart. Guarded by `closing` so it can never race a real close.
   */
  private async sweepMeteredIdle(): Promise<void> {
    if (!this.deps.metered?.enabled) return;
    const now = Date.now();
    for (const active of this.store.listActiveSessions()) {
      if (!active.metered || !isIdleExpired(active.metered, now)) continue;
      if (this.closing.has(active.grant.sessionId)) continue;
      this.closing.add(active.grant.sessionId);
      try {
        const settleTokens = settleTokensAtCutoff(active.metered);
        const verified = rungToSettle(active.metered)?.verified ?? active.verified;
        await this.finalizeSettlement(active, settleTokens, verified, "metered_watchdog_cutoff");
        await this.deps.revokeConsumer?.(active.grant.consumerPublicKey);
      } catch (err) {
        this.deps.audit.record({ event: "note", extra: { role: "economy", phase: "metered_watchdog_error", sessionId: active.grant.sessionId, error: err instanceof Error ? err.message : String(err) } });
      } finally {
        this.closing.delete(active.grant.sessionId);
      }
    }
  }

  async retryUnsettled(opts: { force?: boolean } = {}): Promise<void> {
    for (const pending of this.store.listUnsettled()) {
      if (!opts.force && Date.parse(pending.nextRetryAt) > Date.now()) continue;
      const result = await this.deps.plasma.settleVerified(pending.verified, pending.receipt.actualAmount);
      if (result.ok) {
        const settledAt = new Date().toISOString();
        const settledBase = {
          ...pending.receipt,
          status: "settled" as const,
          settledAt,
          txHash: result.txRef,
          retryCount: (pending.receipt.retryCount ?? 1) + 1,
        };
        const receipt = {
          ...settledBase,
          failureReason: undefined,
          providerSignature: signProviderPayload(this.deps.seed, { ...settledBase, failureReason: undefined }),
        };
        this.store.removeUnsettled(receipt.sessionId);
        this.store.putSettled(receipt);
        this.clearBlockIfPossible(receipt.payerAddress);
        await this.publishReceipt(receipt);
        this.deps.audit.record({
          event: "note",
          extra: { role: "economy", phase: "retry_settlement", sessionId: receipt.sessionId, status: "settled", txHash: receipt.txHash },
        });
        continue;
      }
      const retryCount = (pending.receipt.retryCount ?? 1) + 1;
      const nextRetryAt = new Date(Date.now() + Math.min(RETRY_BASE_MS * retryCount, RETRY_MAX_MS)).toISOString();
      const retryBase = {
        ...pending.receipt,
        status: "retrying" as const,
        settledAt: null,
        txHash: "",
        failureReason: result.reason,
        retryCount,
      };
      const receipt = {
        ...retryBase,
        providerSignature: signProviderPayload(this.deps.seed, retryBase),
      };
      this.store.putUnsettled({ ...pending, receipt, nextRetryAt });
      this.blockPayer(receipt.payerAddress, receipt.sessionId, result.reason);
      await this.publishReceipt(receipt);
      this.deps.audit.record({
        event: "note",
        extra: { role: "economy", phase: "retry_settlement", sessionId: receipt.sessionId, status: "retrying", failureReason: result.reason, retryCount },
      });
    }
  }

  private async validateMeshBinding(meshId: string, consumerWriterKey: string, consumerPublicKey: string): Promise<MeshParticipant> {
    const participant = await this.deps.resolveMeshParticipant(meshId, consumerWriterKey);
    if (!participant) throw new Error("consumer is not a member of the requested mesh");
    if (participant.visibility !== "private") throw new Error("public meshes never participate in compute settlement");
    if (participant.consumerPublicKey !== consumerPublicKey) throw new Error("consumer public key does not match the mesh capability");
    return participant;
  }

  private assertQuoteLive(quote: PaidSessionQuote): void {
    if (Date.parse(quote.expiry) <= Date.now()) throw new Error("quoted budget expired");
  }

  private buildReceipt(
    active: ActiveSessionRecord,
    opts: {
      actualTokens: number;
      actualAmount: number;
      completedAt: string;
      settledAt: string | null;
      status: SessionSettlementReceipt["status"];
      txHash: string;
      failureReason?: string;
      retryCount?: number;
    },
  ): SessionSettlementReceipt {
    const base = {
      sessionId: active.grant.sessionId,
      meshId: active.grant.meshId,
      alias: active.grant.alias,
      modelSrc: active.grant.modelSrc,
      budgetCap: active.grant.maxAmount,
      actualTokens: opts.actualTokens,
      actualAmount: opts.actualAmount,
      network: "plasma" as const,
      networkId: active.grant.networkId,
      asset: active.recipient.asset,
      txHash: opts.txHash,
      openedAt: active.openedAt,
      completedAt: opts.completedAt,
      settledAt: opts.settledAt,
      status: opts.status,
      payerId: active.grant.consumerPublicKey,
      payerAddress: active.grant.payerAddress,
      providerId: active.grant.providerPublicKey,
      providerAddress: active.recipient.recipient,
      consumerWriterKey: active.grant.consumerWriterKey,
      consumerPublicKey: active.grant.consumerPublicKey,
      providerWriterKey: active.grant.providerWriterKey,
      providerPublicKey: active.grant.providerPublicKey,
      payTo: active.grant.payTo,
      nonce: active.grant.nonce,
      x402Version: 2 as const,
      scheme: "upto" as const,
      ...(opts.failureReason ? { failureReason: opts.failureReason } : {}),
      ...(opts.retryCount != null ? { retryCount: opts.retryCount } : {}),
    };
    return {
      ...base,
      providerSignature: signProviderPayload(this.deps.seed, base),
    };
  }

  private blockPayer(payerAddress: string, sessionId: string, reason: string): void {
    const current = this.store.getBlockedPayer(payerAddress);
    const record: BlockedPayerRecord = {
      payerAddress,
      reason,
      receiptIds: [...new Set([...(current?.receiptIds ?? []), sessionId])],
      updatedAt: new Date().toISOString(),
    };
    this.store.putBlockedPayer(record);
  }

  private clearBlockIfPossible(payerAddress: string): void {
    const stillUnsettled = this.store.listUnsettled().some((entry) => entry.receipt.payerAddress === payerAddress);
    if (!stillUnsettled) this.store.clearBlockedPayer(payerAddress);
  }

  private async publishReceipt(receipt: SessionSettlementReceipt): Promise<void> {
    await this.deps.publishReceipt(receipt.meshId, receipt);
  }
}
