/**
 * Smoke: paid-session control protocol lifecycle.
 *
 *   npx tsx apps/hypha/scripts/smoke-payment-session.ts
 *
 * Exercises the real P2P control server/client around a fake Plasma rail:
 * quote -> verify -> open -> close -> retry unblock, plus restart recovery of
 * active/unsettled provider state.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuditLog, SessionSettlementReceipt, SettlementEndpoint } from "@mycelium/shared";
import { localBorrowableAliases } from "../src/catalog.ts";
import { ProviderEconomyService } from "../src/provider-economy.ts";
import { PaymentControlClient, PaymentControlServer } from "../src/payment-control.ts";

const expect = (label: string, ok: boolean): void => {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`✅ ${label}`);
};

const fakeAudit = { record: () => ({}) } as unknown as AuditLog;
const alias = localBorrowableAliases()[0];
if (!alias) throw new Error("No served chat alias is configured; Hypha needs at least one alias for the payment-session smoke.");

const providerPublicKey = "provider-public-key";
const providerWriterKey = "provider-writer-key";
const consumerPublicKey = "consumer-public-key";
const consumerWriterKey = "consumer-writer-key";
const payerAddress = "0xpayer";
const meshId = "mesh-private-1";
const seed = "11".repeat(32);

function fakePlasma(failures: { settle: boolean }) {
  const endpoint: SettlementEndpoint = {
    network: "plasma",
    networkId: "eip155:9745",
    asset: "USDT",
    mint: "0xusdt",
    decimals: 6,
    recipient: "0xprovider",
    x402: { version: 2, scheme: "upto", facilitator: "0xfacilitator", maxTimeoutSeconds: 900, pricePerKiloToken: 10 },
  };
  return {
    payoutEndpoint: () => endpoint,
    maxBudget: () => 100,
    amountForTokens: (tokens: number) => Math.ceil((tokens / 1000) * 10),
    verifyBudget: async (_provider: string, maxAmount: number, _recipient: SettlementEndpoint, _payload: unknown, accepted: { amount: string }) => {
      if (accepted.amount !== String(maxAmount)) return { ok: false as const, reason: "amount mismatch" };
      return {
        ok: true as const,
        verification: {
          provider: providerPublicKey,
          maxAmount,
          recipient: endpoint,
          paymentPayload: { x402Version: 2, payload: { permit: "signed" }, accepted } as never,
          accepted: {
            scheme: "upto",
            network: "eip155:9745",
            asset: endpoint.mint,
            amount: String(maxAmount),
            payTo: endpoint.recipient,
            maxTimeoutSeconds: 900,
            extra: { facilitatorAddress: endpoint.x402?.facilitator ?? endpoint.recipient },
          },
        },
      };
    },
    settleVerified: async (_verification: unknown, actualAmount: number) => {
      if (failures.settle) return { ok: false as const, reason: "facilitator offline" };
      return {
        ok: true as const,
        network: "plasma",
        amount: actualAmount,
        txRef: `tx-${actualAmount}`,
        recipient: endpoint.recipient,
        asset: endpoint.asset,
        mint: endpoint.mint,
        mode: "x402-upto" as const,
      };
    },
  };
}

function service(storeDir: string, failures: { settle: boolean }, receipts: SessionSettlementReceipt[]): ProviderEconomyService {
  return new ProviderEconomyService({
    seed,
    audit: fakeAudit,
    storeDir,
    plasma: fakePlasma(failures) as never,
    providerPublicKey: () => providerPublicKey,
    resolveMeshParticipant: async (askedMeshId, askedConsumerWriterKey) =>
      askedMeshId === meshId && askedConsumerWriterKey === consumerWriterKey
        ? { visibility: "private" as const, providerWriterKey, consumerPublicKey }
        : null,
    publishReceipt: async (_meshId, receipt) => { receipts.push(receipt); },
    retryIntervalMs: 60_000,
  });
}

async function main(): Promise<void> {
  const root = join(tmpdir(), `hypha-payment-session-${Date.now()}`);
  const failures = { settle: false };
  const receipts: SessionSettlementReceipt[] = [];
  const economy = service(root, failures, receipts);
  const server = new PaymentControlServer({ seed, audit: fakeAudit, economy });
  const client = new PaymentControlClient(() => consumerPublicKey, seed);
  await server.ready();
  await server.updateAllowedConsumers(providerPublicKey, new Set([consumerPublicKey]));

  try {
    const quote = await client.quoteBudget(providerPublicKey, {
      meshId,
      alias: alias.alias,
      modelSrc: alias.modelSrc,
      requestedBudget: 77,
      consumerWriterKey,
      consumerPublicKey,
      providerPublicKey,
    });
    expect("quote returns the fixed capped budget for one completion", quote.maxAmount === 77 && quote.modelSrc === alias.modelSrc);

    const verifyReq = {
      quote,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "nonce-1",
      paymentPayload: { x402Version: 2, payload: { permit: "signed" }, accepted: {} } as never,
      accepted: {
        scheme: "upto",
        network: "eip155:9745",
        asset: "0xusdt",
        amount: "77",
        payTo: "0xprovider",
        maxTimeoutSeconds: 900,
        extra: { facilitatorAddress: "0xfacilitator" },
      },
    };
    const verified = await client.verifyBudget(providerPublicKey, verifyReq);
    expect("verify_budget accepts a fresh matching x402 payload", typeof verified.verificationId === "string");

    let replayRejected = false;
    try {
      await client.verifyBudget(providerPublicKey, verifyReq);
    } catch {
      replayRejected = true;
    }
    expect("replaying the same authorization is rejected before session open", replayRejected);

    const grant = await client.openPaidSession(providerPublicKey, {
      quote,
      verificationId: verified.verificationId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "nonce-1",
    });
    expect("open_paid_session returns a provider-signed grant bound to the mesh and alias", grant.meshId === meshId && grant.alias === alias.alias);

    const settled = await client.closePaidSession(providerPublicKey, {
      sessionId: grant.sessionId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      actualTokens: 4200,
    });
    expect("close_paid_session settles immediately when the facilitator succeeds", settled.status === "settled" && settled.actualAmount === 42);

    failures.settle = true;
    const quote2 = await client.quoteBudget(providerPublicKey, {
      meshId,
      alias: alias.alias,
      requestedBudget: 90,
      consumerWriterKey,
      consumerPublicKey,
      providerPublicKey,
    });
    const verified2 = await client.verifyBudget(providerPublicKey, {
      ...verifyReq,
      quote: quote2,
      nonce: "nonce-2",
      accepted: { ...verifyReq.accepted, amount: "90" },
    });
    const grant2 = await client.openPaidSession(providerPublicKey, {
      quote: quote2,
      verificationId: verified2.verificationId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "nonce-2",
    });
    const retrying = await client.closePaidSession(providerPublicKey, {
      sessionId: grant2.sessionId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      actualTokens: 5000,
    });
    expect("settlement failure moves the receipt into retrying state", retrying.status === "retrying" && retrying.actualAmount === 50);
    expect("the payer is blocked while debt is unsettled", economy.snapshot().blockedPayers === 1 && economy.snapshot().unsettledReceipts === 1);

    failures.settle = false;
    await economy.retryUnsettled({ force: true });
    expect("retryUnsettled settles the queued receipt and clears the block", economy.snapshot().blockedPayers === 0 && economy.snapshot().unsettledReceipts === 0);

    const restartDir = join(root, "restart-check");
    const restartReceipts: SessionSettlementReceipt[] = [];
    const first = service(restartDir, failures, restartReceipts);
    const q3 = await first.quoteBudget({
      meshId,
      alias: alias.alias,
      requestedBudget: 30,
      consumerWriterKey,
      consumerPublicKey,
      providerPublicKey,
    });
    const v3 = await first.verifyBudget({
      quote: q3,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "nonce-3",
      paymentPayload: verifyReq.paymentPayload,
      accepted: { ...verifyReq.accepted, amount: "30" },
    });
    await first.openPaidSession({
      quote: q3,
      verificationId: v3.verificationId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "nonce-3",
    });
    first.stop();
    const second = service(restartDir, failures, restartReceipts);
    expect("active provider session state reloads after restart", second.snapshot().activeSessions === 1);
    second.stop();

    expect("receipts were mirrored into the mesh-visible publish hook", receipts.some((receipt) => receipt.sessionId === settled.sessionId));
    console.log("\n🟢 PASS — paid-session protocol enforces verify/open/close/retry with durable provider state");
  } finally {
    economy.stop();
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
