import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { SessionSettlementReceipt, SettlementEndpoint } from "@mycelium/shared";
import type { PlasmaVerifiedBudget } from "./plasma-settlement.ts";

export interface PaidSessionQuote {
  quoteId: string;
  meshId: string;
  alias: string;
  modelSrc: string;
  maxAmount: number;
  expiry: string;
  x402Version: 2;
  scheme: "upto";
  network: "plasma";
  networkId?: string;
  asset: string;
  payTo: string;
  facilitator: string;
  pricePerKiloToken: number;
  /**
   * Metered sessions only (provider has HYPHA_ECONOMY_METERED on): the tier-0 cap the consumer signs
   * at open, and the per-chunk token count. `maxAmount` stays the ceiling the ladder may escalate to.
   * Absent = the proven single-settle session (consumer signs `maxAmount` at open).
   */
  meteredChunkTokens?: number;
  meteredChunkAmount?: number;
  providerWriterKey: string;
  providerPublicKey: string;
}

export interface PendingBudgetVerification {
  verificationId: string;
  quote: PaidSessionQuote;
  payerAddress: string;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  nonce: string;
  authorizationDigest: string;
  verified: PlasmaVerifiedBudget;
}

export interface PaidSessionGrant {
  sessionId: string;
  meshId: string;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  alias: string;
  modelSrc: string;
  maxAmount: number;
  expiry: string;
  x402Version: 2;
  scheme: "upto";
  networkId?: string;
  payerAddress: string;
  payTo: string;
  nonce: string;
  authorizationDigest: string;
  providerSignature: string;
}

export interface ActiveSessionRecord {
  grant: PaidSessionGrant;
  verified: PlasmaVerifiedBudget;
  recipient: SettlementEndpoint;
  openedAt: string;
  /** Present only for metered (pay-as-you-go) sessions; absent = the proven single-settle path. */
  metered?: MeteredState;
}

// ── Metered (pay-as-you-go) sessions — escalating-authorization ladder (additive; opt-in) ─────────
//
// A consumer cannot raise a single x402 "upto" signature's cap, so in a metered session it sends a
// FRESH Permit2 witness for a higher CUMULATIVE token cap before each new decode chunk. Each rung is
// an independent authorization drawn against the SAME reused max-uint Permit2 allowance; the provider
// settles exactly ONE rung at close (the highest reached), so money still moves once and gas stays
// O(1) per session. The pure mechanism (append/idempotency/settle-selection/watchdog) lives in
// metered.ts; these are just the persisted shapes + the control message.

/** One rung of the escalating-authorization ladder. */
export interface AuthorizationRung {
  /** Monotonic 0,1,2…; tier-0 is the session open, higher tiers are advances. */
  tierIndex: number;
  /** Cumulative token cap this rung authorizes (from session start, not per-chunk). */
  cumulativeTokens: number;
  /** amountForTokens(cumulativeTokens) — the on-chain cap this rung's signature covers. */
  cumulativeAmount: number;
  /** Replay guard for this rung (digestAuthorization over its own per-rung nonce). */
  authorizationDigest: string;
  /** The verified budget used to settle THIS rung on-chain (independent per rung). */
  verified: PlasmaVerifiedBudget;
  acceptedAt: string;
}

/** Per-session metered state, persisted on the ActiveSessionRecord. */
export interface MeteredState {
  /** Tokens the consumer may decode per chunk before it must advance the authorization. */
  chunkTokens: number;
  /** Idle budget: no advance within this window → the watchdog force-settles the authorized cap. */
  advanceWindowMs: number;
  /** Rungs sorted by tierIndex asc; the last is the current cap. */
  ladder: AuthorizationRung[];
  /** = the top rung's cumulativeTokens (the most the provider may charge). */
  acceptedThroughTokens: number;
  /** ISO ts of the last accepted advance (or the open) — the watchdog's idle clock. */
  lastAdvanceAt: string;
}

export interface UnsettledReceiptRecord {
  receipt: SessionSettlementReceipt;
  verified: PlasmaVerifiedBudget;
  nextRetryAt: string;
}

export interface BlockedPayerRecord {
  payerAddress: string;
  reason: string;
  receiptIds: string[];
  updatedAt: string;
}

export interface UsedAuthorizationRecord {
  authorizationDigest: string;
  sessionId: string;
  usedAt: string;
}

export interface QuoteBudgetRequest {
  meshId: string;
  alias: string;
  modelSrc?: string;
  requestedBudget?: number;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerPublicKey: string;
}

export interface VerifyBudgetRequest {
  quote: PaidSessionQuote;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  payerAddress: string;
  nonce: string;
  paymentPayload: PaymentPayload;
  accepted: PaymentRequirements;
}

export interface VerifyBudgetResponse {
  verificationId: string;
  authorizationDigest: string;
}

export interface OpenPaidSessionRequest {
  quote: PaidSessionQuote;
  verificationId: string;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  payerAddress: string;
  nonce: string;
}

export interface ClosePaidSessionRequest {
  sessionId: string;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  actualTokens: number;
}

/**
 * Metered escalation: a fresh Permit2 witness for a higher cumulative token cap, sent before the
 * next decode chunk. Idempotent on (sessionId, tierIndex) so a re-sent advance is a safe no-op.
 */
export interface AdvanceAuthorizationRequest {
  sessionId: string;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  tierIndex: number;
  cumulativeTokens: number;
  payerAddress: string;
  /** Per-rung nonce (e.g. `${sessionId}:${tierIndex}`) so each rung digests + verifies distinctly. */
  nonce: string;
  paymentPayload: PaymentPayload;
  accepted: PaymentRequirements;
}

export interface AdvanceAuthorizationResponse {
  sessionId: string;
  tierIndex: number;
  acceptedThroughTokens: number;
}

export type PaymentControlRequest =
  | { id: string; type: "quote_budget"; body: QuoteBudgetRequest }
  | { id: string; type: "verify_budget"; body: VerifyBudgetRequest }
  | { id: string; type: "open_paid_session"; body: OpenPaidSessionRequest }
  | { id: string; type: "advance_authorization"; body: AdvanceAuthorizationRequest }
  | { id: string; type: "close_paid_session"; body: ClosePaidSessionRequest };

export type PaymentControlSuccess =
  | { replyTo: string; type: "quote_budget"; ok: true; body: PaidSessionQuote }
  | { replyTo: string; type: "verify_budget"; ok: true; body: VerifyBudgetResponse }
  | { replyTo: string; type: "open_paid_session"; ok: true; body: PaidSessionGrant }
  | { replyTo: string; type: "advance_authorization"; ok: true; body: AdvanceAuthorizationResponse }
  | { replyTo: string; type: "settlement_receipt"; ok: true; body: SessionSettlementReceipt };

export type PaymentControlFailure = {
  replyTo: string;
  type: PaymentControlRequest["type"] | "settlement_receipt";
  ok: false;
  error: string;
  code?: string;
};

export type PaymentControlResponse = PaymentControlSuccess | PaymentControlFailure;

export function controlRequestId(): string {
  return randomUUID();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function digestAuthorization(parts: {
  quote: Pick<PaidSessionQuote, "quoteId" | "meshId" | "alias" | "modelSrc" | "maxAmount" | "providerPublicKey" | "providerWriterKey">;
  paymentPayload: PaymentPayload;
  accepted: PaymentRequirements;
  consumerWriterKey: string;
  consumerPublicKey: string;
  payerAddress: string;
  nonce: string;
}): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

export function signProviderPayload(seedHex: string, value: unknown): string {
  return createHmac("sha256", Buffer.from(seedHex, "hex")).update(canonicalJson(value)).digest("hex");
}
