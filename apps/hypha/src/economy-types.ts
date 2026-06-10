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

export type PaymentControlRequest =
  | { id: string; type: "quote_budget"; body: QuoteBudgetRequest }
  | { id: string; type: "verify_budget"; body: VerifyBudgetRequest }
  | { id: string; type: "open_paid_session"; body: OpenPaidSessionRequest }
  | { id: string; type: "close_paid_session"; body: ClosePaidSessionRequest };

export type PaymentControlSuccess =
  | { replyTo: string; type: "quote_budget"; ok: true; body: PaidSessionQuote }
  | { replyTo: string; type: "verify_budget"; ok: true; body: VerifyBudgetResponse }
  | { replyTo: string; type: "open_paid_session"; ok: true; body: PaidSessionGrant }
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
