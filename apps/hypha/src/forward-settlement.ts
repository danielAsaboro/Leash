// Forward-path x402 settlement drive (SP2 Option B, B4 step 2b). The forward transport carries no payment
// itself; when HYPHA_FORWARD_METERED is on and the chosen peer advertises a paid (plasma+upto) rail, the
// consumer opens an x402 paid session AROUND the forward request and settles the ACTUAL billing-tokens at
// close. Mirrors the delegated metered flow (shim.ts:640-1058) but ATOMIC — open once, close once, no
// per-rung advanceAuthorization (a forward request's usage is known only at done, all at once).
//
// Money-bug guardrails carried over from the delegated path:
//  - NON-metered open: authorize the full maxAmount up front; the close settles actual ≤ maxAmount.
//  - closeAttempted: the CALLER sets it true immediately before closeForwardSession so a failure can't
//    fire a second (zero-)close that would settle the session out from under the provider (race c112b243).
//  - Single peer, NO failover under a paid session — open/forward/close all bind to one provider.

import { randomUUID } from "node:crypto";
import type { AuditLog } from "@mycelium/shared";
import type { PaymentControlClient } from "./payment-control.ts";
import type { SettlementManager, BudgetAuthorization } from "./settlement-manager.ts";
import type { PaidSessionGrant } from "./economy-types.ts";
import type { ForwardSettlementMeta } from "./mesh-router.ts";

export interface ForwardSettlementDeps {
  paymentControl: PaymentControlClient;
  settlement: SettlementManager;
  selfConsumerKey: string;
  audit?: AuditLog;
}

/** An open paid forward session — everything closeForwardSession needs to settle + finalize. */
export interface ForwardSession {
  peerKey: string;
  grant: PaidSessionGrant;
  budgetAuth: BudgetAuthorization;
}

export type OpenForwardResult =
  | { ok: true; session: ForwardSession }
  | { ok: false; status: number; error: string };

/**
 * Open an x402 paid session for ONE forward request: quote → authorize the full maxAmount → verify → open.
 * `ceilingTokens` bounds the budget (the close settles the real billing-tokens, ≤ this).
 */
export async function openForwardSession(deps: ForwardSettlementDeps, meta: ForwardSettlementMeta, peerKey: string, alias: string, ceilingTokens: number): Promise<OpenForwardResult> {
  const { paymentControl, settlement } = deps;
  const plasma = settlement.plasmaService();
  if (!plasma) return { ok: false, status: 402, error: "peer requires a paid session but local x402 is unavailable" };

  // EVERYTHING is wrapped: a provider-side rejection (e.g. "consumer is not a member of the requested
  // mesh") rejects the paymentControl RPC promise — if that escaped it would be an unhandled error and
  // crash the daemon. Any failure → a clean 402; release the float if we authorized before failing.
  let auth: BudgetAuthorization | undefined;
  try {
    const quote = await paymentControl.quoteBudget(peerKey, {
      meshId: meta.meshId,
      alias,
      ...(meta.modelSrc ? { modelSrc: meta.modelSrc } : {}),
      requestedBudget: plasma.amountForTokens(Math.max(1, Math.ceil(ceilingTokens))),
      consumerWriterKey: meta.consumerWriterKey,
      consumerPublicKey: deps.selfConsumerKey,
      providerPublicKey: peerKey,
    });
    // Atomic forward path: the NON-metered open (sign the full maxAmount now; settle actual at close).
    const budgetAuth = await settlement.authorizeBudget(peerKey, quote.maxAmount);
    if (!budgetAuth.ok || budgetAuth.authorization.network !== "plasma") {
      return { ok: false, status: 402, error: budgetAuth.ok ? "no Plasma x402 authorization path is available" : budgetAuth.reason };
    }
    auth = budgetAuth.authorization;
    const nonce = `fwd-${randomUUID()}`;
    const verify = await paymentControl.verifyBudget(peerKey, {
      quote,
      consumerWriterKey: meta.consumerWriterKey,
      consumerPublicKey: deps.selfConsumerKey,
      providerWriterKey: quote.providerWriterKey,
      providerPublicKey: peerKey,
      payerAddress: auth.authorization.payer,
      nonce,
      paymentPayload: auth.authorization.paymentPayload,
      accepted: auth.authorization.accepted,
    });
    const grant = await paymentControl.openPaidSession(peerKey, {
      quote,
      verificationId: verify.verificationId,
      consumerWriterKey: meta.consumerWriterKey,
      consumerPublicKey: deps.selfConsumerKey,
      providerWriterKey: quote.providerWriterKey,
      providerPublicKey: peerKey,
      payerAddress: auth.authorization.payer,
      nonce,
    });
    deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-session-open", peer: peerKey.slice(0, 16), alias, sessionId: grant.sessionId, maxAmount: quote.maxAmount } });
    return { ok: true, session: { peerKey, grant, budgetAuth: auth } };
  } catch (err) {
    if (auth) settlement.releaseAuthorized(auth); // authorized but verify/open failed → return the float
    return { ok: false, status: 402, error: `paid session open failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Close the paid session, settling `billingTokens` (clamped ≥ 0). The CALLER must set its own
 * closeAttempted=true immediately before calling this — never call it twice for one session.
 */
export async function closeForwardSession(deps: ForwardSettlementDeps, session: ForwardSession, billingTokens: number): Promise<void> {
  const receipt = await deps.paymentControl.closePaidSession(session.peerKey, {
    sessionId: session.grant.sessionId,
    consumerWriterKey: session.grant.consumerWriterKey,
    consumerPublicKey: session.grant.consumerPublicKey,
    providerWriterKey: session.grant.providerWriterKey,
    providerPublicKey: session.peerKey,
    actualTokens: Math.max(0, Math.round(billingTokens)),
  });
  if (receipt.status === "settled" && session.budgetAuth.network === "plasma") {
    await deps.settlement.finalizeAuthorized(session.budgetAuth, receipt.actualAmount, receipt.txHash ?? "");
  }
  deps.audit?.record({ event: "delegation", extra: { role: "consumer", phase: "forward-session-close", peer: session.peerKey.slice(0, 16), sessionId: session.grant.sessionId, billingTokens: Math.max(0, Math.round(billingTokens)), status: receipt.status, amount: receipt.actualAmount } });
}
