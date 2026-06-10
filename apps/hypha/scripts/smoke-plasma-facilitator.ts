/**
 * Smoke: provider-side Plasma facilitator verification + settlement guards.
 *
 *   npx tsx apps/hypha/scripts/smoke-plasma-facilitator.ts
 *
 * Deterministic, offline fake-facilitator check around ProviderEconomyService:
 * wrong mesh/model/expiry are rejected, a fresh verify/open/close settles within
 * cap, and replay is blocked by the used-authorization ledger.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuditLog, SettlementEndpoint } from "@mycelium/shared";
import { localChatAliases } from "../src/catalog.ts";
import { ProviderEconomyService } from "../src/provider-economy.ts";

const expect = (label: string, ok: boolean): void => {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`✅ ${label}`);
};

const fakeAudit = { record: () => ({}) } as unknown as AuditLog;
const alias = localChatAliases()[0];
if (!alias) throw new Error("No served chat alias is configured; Hypha needs at least one alias for the Plasma smoke.");

const providerPublicKey = "provider-public-key";
const providerWriterKey = "provider-writer-key";
const consumerPublicKey = "consumer-public-key";
const consumerWriterKey = "consumer-writer-key";
const payerAddress = "0xpayer";
const meshId = "mesh-private-1";
const endpoint: SettlementEndpoint = {
  network: "plasma",
  networkId: "eip155:9745",
  asset: "USDT",
  mint: "0xusdt",
  decimals: 6,
  recipient: "0xprovider",
  x402: { version: 2, scheme: "upto", facilitator: "0xfacilitator", maxTimeoutSeconds: 900, pricePerKiloToken: 10 },
};

function makeEconomy(root: string): ProviderEconomyService {
  return new ProviderEconomyService({
    seed: "22".repeat(32),
    audit: fakeAudit,
    storeDir: root,
    plasma: {
      payoutEndpoint: () => endpoint,
      maxBudget: () => 100,
      amountForTokens: (tokens: number) => Math.ceil((tokens / 1000) * 10),
      verifyBudget: async (_provider: string, maxAmount: number, _recipient: SettlementEndpoint, _payload: unknown, accepted: { amount: string }) =>
        accepted.amount === String(maxAmount)
          ? {
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
                extra: { facilitatorAddress: "0xfacilitator" },
              },
            },
          }
          : { ok: false as const, reason: "amount mismatch" },
      settleVerified: async (_verification: unknown, actualAmount: number) => ({
        ok: true as const,
        network: "plasma",
        amount: actualAmount,
        txRef: `tx-${actualAmount}`,
        recipient: endpoint.recipient,
        asset: endpoint.asset,
        mint: endpoint.mint,
        mode: "x402-upto" as const,
      }),
    } as never,
    providerPublicKey: () => providerPublicKey,
    resolveMeshParticipant: async (askedMeshId, askedConsumerWriterKey) =>
      askedMeshId === meshId && askedConsumerWriterKey === consumerWriterKey
        ? { visibility: "private" as const, providerWriterKey, consumerPublicKey }
        : null,
    publishReceipt: async () => {},
    retryIntervalMs: 60_000,
  });
}

async function main(): Promise<void> {
  const root = join(tmpdir(), `hypha-plasma-facilitator-${Date.now()}`);
  const economy = makeEconomy(root);
  try {
    let wrongMeshRejected = false;
    try {
      await economy.quoteBudget({
        meshId: "mesh-public",
        alias: alias.alias,
        consumerWriterKey,
        consumerPublicKey,
        providerPublicKey,
      });
    } catch {
      wrongMeshRejected = true;
    }
    expect("quote_budget rejects a consumer outside the requested private mesh", wrongMeshRejected);

    const quote = await economy.quoteBudget({
      meshId,
      alias: alias.alias,
      requestedBudget: 60,
      consumerWriterKey,
      consumerPublicKey,
      providerPublicKey,
    });

    let badModelRejected = false;
    try {
      await economy.verifyBudget({
        quote: { ...quote, modelSrc: quote.modelSrc + "-tampered" },
        consumerWriterKey,
        consumerPublicKey,
        providerWriterKey,
        providerPublicKey,
        payerAddress,
        nonce: "n1",
        paymentPayload: { x402Version: 2, payload: { permit: "signed" }, accepted: {} } as never,
        accepted: {
          scheme: "upto",
          network: "eip155:9745",
          asset: "0xusdt",
          amount: "60",
          payTo: "0xprovider",
          maxTimeoutSeconds: 900,
          extra: { facilitatorAddress: "0xfacilitator" },
        },
      });
    } catch {
      badModelRejected = true;
    }
    expect("verify_budget rejects a tampered alias/model binding", badModelRejected);

    let expiredRejected = false;
    try {
      await economy.verifyBudget({
        quote: { ...quote, expiry: new Date(Date.now() - 1000).toISOString() },
        consumerWriterKey,
        consumerPublicKey,
        providerWriterKey,
        providerPublicKey,
        payerAddress,
        nonce: "n2",
        paymentPayload: { x402Version: 2, payload: { permit: "signed" }, accepted: {} } as never,
        accepted: {
          scheme: "upto",
          network: "eip155:9745",
          asset: "0xusdt",
          amount: "60",
          payTo: "0xprovider",
          maxTimeoutSeconds: 900,
          extra: { facilitatorAddress: "0xfacilitator" },
        },
      });
    } catch {
      expiredRejected = true;
    }
    expect("verify_budget rejects an expired authorization window", expiredRejected);

    const verified = await economy.verifyBudget({
      quote,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "n3",
      paymentPayload: { x402Version: 2, payload: { permit: "signed" }, accepted: {} } as never,
      accepted: {
        scheme: "upto",
        network: "eip155:9745",
        asset: "0xusdt",
        amount: "60",
        payTo: "0xprovider",
        maxTimeoutSeconds: 900,
        extra: { facilitatorAddress: "0xfacilitator" },
      },
    });
    const grant = await economy.openPaidSession({
      quote,
      verificationId: verified.verificationId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      payerAddress,
      nonce: "n3",
    });
    const receipt = await economy.closePaidSession({
      sessionId: grant.sessionId,
      consumerWriterKey,
      consumerPublicKey,
      providerWriterKey,
      providerPublicKey,
      actualTokens: 5100,
    });
    expect("close_paid_session settles the actual amount at or below the cap", receipt.status === "settled" && receipt.actualAmount === 51 && receipt.actualAmount <= receipt.budgetCap);

    let replayRejected = false;
    try {
      await economy.verifyBudget({
        quote,
        consumerWriterKey,
        consumerPublicKey,
        providerWriterKey,
        providerPublicKey,
        payerAddress,
        nonce: "n3",
        paymentPayload: { x402Version: 2, payload: { permit: "signed" }, accepted: {} } as never,
        accepted: {
          scheme: "upto",
          network: "eip155:9745",
          asset: "0xusdt",
          amount: "60",
          payTo: "0xprovider",
          maxTimeoutSeconds: 900,
          extra: { facilitatorAddress: "0xfacilitator" },
        },
      });
    } catch {
      replayRejected = true;
    }
    expect("used_authorizations rejects the replay after session close", replayRejected);

    console.log("\n🟢 PASS — provider-side Plasma verify/open/settle guards reject tampering and replay");
  } finally {
    economy.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
