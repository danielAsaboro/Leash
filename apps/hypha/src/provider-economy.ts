import { randomUUID } from "node:crypto";
import type { AuditLog, SessionSettlementReceipt, Visibility } from "@mycelium/shared";
import { localChatAliases } from "./catalog.ts";
import { signProviderPayload, digestAuthorization, type ActiveSessionRecord, type BlockedPayerRecord, type ClosePaidSessionRequest, type OpenPaidSessionRequest, type PaidSessionGrant, type PaidSessionQuote, type PendingBudgetVerification, type QuoteBudgetRequest, type UnsettledReceiptRecord, type VerifyBudgetRequest, type VerifyBudgetResponse } from "./economy-types.ts";
import type { PlasmaSettlementService } from "./plasma-settlement.ts";
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
    this.timer = setInterval(() => void this.retryUnsettled(), interval);
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
    const verified = await this.deps.plasma.verifyBudget(
      providerPublicKey,
      req.quote.maxAmount,
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
    const record: ActiveSessionRecord = {
      grant,
      verified: pending.verified,
      recipient: pending.verified.recipient,
      openedAt: new Date().toISOString(),
    };
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
    const completedAt = new Date().toISOString();
    const actualTokens = Math.max(0, Math.floor(req.actualTokens));
    const actualAmount = this.deps.plasma.amountForTokens(actualTokens);
    const result = await this.deps.plasma.settleVerified(active.verified, actualAmount);
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
    this.store.removeActiveSession(req.sessionId);
    if (result.ok) {
      this.store.putSettled(receipt);
      this.clearBlockIfPossible(receipt.payerAddress);
    } else {
      const unsettled: UnsettledReceiptRecord = {
        receipt,
        verified: active.verified,
        nextRetryAt: new Date(Date.now() + RETRY_BASE_MS).toISOString(),
      };
      this.store.putUnsettled(unsettled);
      this.blockPayer(receipt.payerAddress, receipt.sessionId, result.reason);
    }
    await this.publishReceipt(receipt);
    this.deps.audit.record({
      event: "note",
      extra: { role: "economy", phase: "close_paid_session", meshId: receipt.meshId, sessionId: receipt.sessionId, status: receipt.status, actualAmount: receipt.actualAmount, txHash: receipt.txHash, failureReason: receipt.failureReason },
    });
    return receipt;
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
