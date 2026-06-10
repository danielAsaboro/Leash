/**
 * Smoke: settlement rail order — Plasma first, Solana fallback.
 *
 *   node --import tsx apps/hypha/scripts/smoke-settlement-manager.ts
 */
import { SettlementManager, type SettlementRail } from "../src/settlement-manager.ts";
import type { PlasmaBudgetAuthorization } from "../src/plasma-settlement.ts";
import type { DeviceCapability, SettlementEndpoint } from "@mycelium/shared";

const expect = (label: string, ok: boolean): void => {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`✅ ${label}`);
};

function fakeRail(network: "plasma" | "solana", mint: string, recipient: string, calls: string[], opts: { fail?: boolean } = {}): SettlementRail {
  const endpoint: SettlementEndpoint = { network, asset: "USDT", mint, decimals: 6, recipient };
  return {
    ready: async () => {},
    payoutEndpoint: () => endpoint,
    online: () => true,
    accepts: (rail) => rail.network === network && rail.mint === mint,
    settle: async (_provider, tokens, rail) => {
      calls.push(network);
      if (opts.fail) return { ok: false as const, reason: `${network} down` };
      return { ok: true as const, network, amount: tokens, txRef: `${network}-tx`, recipient: rail.recipient, asset: rail.asset, mint: rail.mint };
    },
  };
}

function fakePlasmaX402Rail(mint: string, calls: string[]) {
  const endpoint: SettlementEndpoint = {
    network: "plasma",
    networkId: "eip155:9745",
    asset: "USDT",
    mint,
    decimals: 6,
    recipient: "0xme",
    x402: { version: 2, scheme: "upto", facilitator: "0xme", maxTimeoutSeconds: 900, pricePerKiloToken: 10 },
  };
  return {
    ready: async () => {},
    payoutEndpoint: () => endpoint,
    online: () => true,
    accepts: (rail: SettlementEndpoint) => rail.network === "plasma" && rail.mint === mint,
    authorize: async (providerKey: string, requestedBudget?: number, recipient?: SettlementEndpoint) => ({
      ok: true as const,
      authorization: {
        provider: providerKey,
        reservationId: "r1",
        maxAmount: requestedBudget ?? 50,
        payer: "0xpayer",
        recipient: recipient ?? endpoint,
        paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        accepted: {} as never,
      } satisfies PlasmaBudgetAuthorization,
    }),
    capture: async (auth: PlasmaBudgetAuthorization, tokens: number) => {
      calls.push(`capture:${auth.maxAmount}:${tokens}`);
      return { ok: true as const, network: "plasma", amount: tokens, txRef: "plasma-x402-tx", recipient: auth.recipient.recipient, asset: auth.recipient.asset, mint: auth.recipient.mint, mode: "x402-upto" };
    },
    settle: async (_provider: string, tokens: number, rail: SettlementEndpoint) => {
      calls.push(`settle:${tokens}`);
      return { ok: true as const, network: "plasma", amount: tokens, txRef: "plasma-direct-tx", recipient: rail.recipient, asset: rail.asset, mint: rail.mint, mode: "x402-upto" };
    },
  };
}

const plasmaMint = "0xplasma-usdt";
const solanaMint = "So11111111111111111111111111111111111111112";
const provider = "peer-provider-key";

const cap = (settlements: SettlementEndpoint[]): DeviceCapability => ({
  deviceId: "peer",
  displayName: "Peer",
  computeClass: "mac",
  ramMB: 16384,
  powerState: "plugged",
  availableModels: [],
  isProvider: true,
  providerPublicKey: provider,
  consumerPublicKey: provider,
  settlements,
  settlement: settlements[0],
  lastSeen: new Date().toISOString(),
});

async function main(): Promise<void> {
  const authCalls: string[] = [];
  const budgetManager = new SettlementManager({
    plasma: fakePlasmaX402Rail(plasmaMint, authCalls),
    solana: fakeRail("solana", solanaMint, "SoMe", []),
  });
  await budgetManager.ready();
  budgetManager.noteCapability(cap([
    {
      network: "plasma",
      networkId: "eip155:9745",
      asset: "USDT",
      mint: plasmaMint,
      decimals: 6,
      recipient: "0xpeer",
      x402: { version: 2, scheme: "upto", facilitator: "0xfac", maxTimeoutSeconds: 900, pricePerKiloToken: 10 },
    },
  ]));
  const auth = await budgetManager.authorizeBudget(provider, 77);
  expect("Plasma x402 budget authorization is attempted before compute", auth.ok && auth.authorization.network === "plasma");
  const captured = auth.ok ? await budgetManager.settleAuthorized(auth.authorization, 42) : null;
  expect("authorized Plasma budgets are captured after compute", !!captured && captured.ok && captured.network === "plasma");
  expect("capture path sees the requested budget and final token charge", authCalls.join(",") === "capture:77:42");

  const calls: string[] = [];
  const manager = new SettlementManager({
    plasma: fakeRail("plasma", plasmaMint, "0xme", calls),
    solana: fakeRail("solana", solanaMint, "SoMe", calls),
  });
  await manager.ready();
  manager.noteCapability(cap([
    { network: "plasma", asset: "USDT", mint: plasmaMint, decimals: 6, recipient: "0xpeer" },
    { network: "solana", asset: "USDT", mint: solanaMint, decimals: 6, recipient: "SoPeer" },
  ]));
  const first = await manager.settle(provider, 42);
  expect("when both rails exist, Plasma is chosen first", first.ok && first.network === "plasma");
  expect("only Plasma was called", calls.join(",") === "plasma");

  const fallbackCalls: string[] = [];
  const fallback = new SettlementManager({
    plasma: fakeRail("plasma", plasmaMint, "0xme", fallbackCalls, { fail: true }),
    solana: fakeRail("solana", solanaMint, "SoMe", fallbackCalls),
  });
  await fallback.ready();
  fallback.noteCapability(cap([
    { network: "plasma", asset: "USDT", mint: plasmaMint, decimals: 6, recipient: "0xpeer" },
    { network: "solana", asset: "USDT", mint: solanaMint, decimals: 6, recipient: "SoPeer" },
  ]));
  const second = await fallback.settle(provider, 42);
  expect("when Plasma fails, Solana is used as fallback", second.ok && second.network === "solana");
  expect("fallback tried Plasma then Solana", fallbackCalls.join(",") === "plasma,solana");

  const solanaOnlyCalls: string[] = [];
  const solanaOnly = new SettlementManager({
    plasma: fakeRail("plasma", plasmaMint, "0xme", solanaOnlyCalls),
    solana: fakeRail("solana", solanaMint, "SoMe", solanaOnlyCalls),
  });
  await solanaOnly.ready();
  solanaOnly.noteCapability(cap([
    { network: "solana", asset: "USDT", mint: solanaMint, decimals: 6, recipient: "SoPeer" },
  ]));
  const third = await solanaOnly.settle(provider, 42);
  expect("when peer only advertises Solana, Solana is used", third.ok && third.network === "solana");
  expect("Plasma is skipped when peer has no compatible Plasma rail", solanaOnlyCalls.join(",") === "solana");

  console.log("\n🟢 PASS — settlement manager prefers Plasma and falls back to Solana");
}

void main();
