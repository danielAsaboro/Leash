/**
 * Phase 2 — Plasma testnet readiness probe.
 *
 * Drives the REAL x402 `upto` rail end-to-end against Plasma testnet (chain 9746):
 *   consumer.authorize()  → ERC20-approve Permit2 + sign x402 budget (consumer gas)
 *   provider.verifyBudget()
 *   provider.settleVerified(actual) → on-chain Permit2 transferFrom consumer→provider (provider gas)
 *
 * Doubles as a funding-status checker: exits 2 (no tx attempted) if XPL gas or USDT0 is missing.
 * Money-safety: hard-refuses any networkId other than eip155:9746.
 *
 *   npx tsx scripts/probe-plasma-settle.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { PlasmaSettlementService } from "../apps/hypha/src/plasma-settlement.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ── env ───────────────────────────────────────────────────────────────────────
const env: Record<string, string> = {};
for (const line of readFileSync(join(root, "data/.economy.probe.env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const RPC = env["PLASMA_RPC_URL"];
const NETWORK_ID = env["PLASMA_NETWORK_ID"];
const chainId = Number(NETWORK_ID.split(":")[1]);
if (chainId !== 9746) {
  console.error(`❌ REFUSING: networkId ${NETWORK_ID} is not Plasma testnet (9746). Mainnet is 9745.`);
  process.exit(1);
}

const EXPLORER = "https://testnet.plasmascan.to";
const provider = getAddress(env["PROVIDER_ADDRESS"]);
const consumer = getAddress(env["CONSUMER_ADDRESS"]);
const candidates = (env["USDT0_CANDIDATES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const chain = {
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: { name: "XPL", symbol: "XPL", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

console.log(`=== Plasma testnet readiness probe (chain ${chainId}) ===`);
console.log(`provider (payee) ${provider}`);
console.log(`consumer (payer) ${consumer}\n`);

// ── 1) XPL gas ─────────────────────────────────────────────────────────────────
const [xplP, xplC] = await Promise.all([pub.getBalance({ address: provider }), pub.getBalance({ address: consumer })]);
console.log(`XPL gas — provider ${formatUnits(xplP, 18)} | consumer ${formatUnits(xplC, 18)}`);
let blocked = false;
if (xplP === 0n) { console.log(`  ⛽ provider needs XPL → ${provider}`); blocked = true; }
if (xplC === 0n) { console.log(`  ⛽ consumer needs XPL → ${consumer}`); blocked = true; }

// ── 2) detect the USDT0 the consumer actually holds ─────────────────────────────
let asset: { mint: `0x${string}`; decimals: number; symbol: string; bal: bigint } | null = null;
for (const c of candidates) {
  const addr = getAddress(c);
  try {
    const [bal, dec, sym] = await Promise.all([
      pub.readContract({ address: addr, abi: ERC20, functionName: "balanceOf", args: [consumer] }) as Promise<bigint>,
      pub.readContract({ address: addr, abi: ERC20, functionName: "decimals" }) as Promise<number>,
      pub.readContract({ address: addr, abi: ERC20, functionName: "symbol" }) as Promise<string>,
    ]);
    console.log(`USDT0 ${addr} — ${sym} dec=${dec} consumerBal=${formatUnits(bal, Number(dec))}`);
    if (bal > 0n && !asset) asset = { mint: addr, decimals: Number(dec), symbol: String(sym), bal };
  } catch (e: any) {
    console.log(`  ${addr} read failed: ${e?.shortMessage ?? e?.message ?? e}`);
  }
}
if (!asset) { console.log(`  💵 consumer holds 0 USDT0 on all candidates → fund it (Alchemy faucet drips 1 USDT0/24h)`); blocked = true; }

if (blocked) { console.log(`\n⏸  Not ready — fund the wallets and re-run. No tx attempted.`); process.exit(2); }

// ── 3) real settle: authorize → verify → settle (1 base unit) ────────────────────
const ASSET = asset!;
console.log(`\n→ ASSET_MINT=${ASSET.mint} (${ASSET.symbol}, ${ASSET.decimals}d)`);

const baseCfg = {
  enabled: true,
  rpcUrl: RPC,
  asset: { symbol: ASSET.symbol, mint: ASSET.mint, decimals: ASSET.decimals, networkId: NETWORK_ID },
  price: { perKiloToken: 1000 },
  limits: { maxPerTx: 1000, maxPerHour: 5000, maxPerCounterparty: 5000 },
  initialFloat: 100_000,
  budgetTimeoutSeconds: 900,
};
const providerSvc = new PlasmaSettlementService({ ...baseCfg, mnemonic: env["PROVIDER_MNEMONIC"] });
const consumerSvc = new PlasmaSettlementService({ ...baseCfg, mnemonic: env["CONSUMER_MNEMONIC"] });
await providerSvc.ready();
await consumerSvc.ready();

const providerEndpoint = providerSvc.payoutEndpoint();
if (!providerEndpoint) throw new Error("provider has no payout endpoint");
console.log(`provider payout: payTo=${providerEndpoint.recipient} facilitator=${providerEndpoint.x402?.facilitator}`);

const BUDGET = 5; // cap, base units
const ACTUAL = 1; // charge, base units
console.log(`\n[1/3] consumer authorize (cap ${BUDGET} base = ${formatUnits(BigInt(BUDGET), ASSET.decimals)} ${ASSET.symbol}; approves Permit2 + signs)…`);
const auth = await consumerSvc.authorize("probe-provider", BUDGET, providerEndpoint);
if (!auth.ok) { console.error(`❌ authorize failed: ${auth.reason}`); process.exit(1); }
console.log(`  ✅ payer=${auth.authorization.payer} reservation=${auth.authorization.reservationId}`);

console.log(`[2/3] provider verifyBudget…`);
const ver = await providerSvc.verifyBudget("probe-provider", BUDGET, providerEndpoint, auth.authorization.paymentPayload, auth.authorization.accepted);
if (!ver.ok) { console.error(`❌ verify failed: ${ver.reason}`); process.exit(1); }
console.log(`  ✅ verified`);

console.log(`[3/3] provider settleVerified (charge ${ACTUAL} base = ${formatUnits(BigInt(ACTUAL), ASSET.decimals)} ${ASSET.symbol})…`);
const res = await providerSvc.settleVerified(ver.verification, ACTUAL);
if (!res.ok) { console.error(`❌ settle failed: ${res.reason}`); process.exit(1); }
console.log(`  ✅ SETTLED amount=${res.amount} tx=${res.txRef}`);
console.log(`  🔗 ${EXPLORER}/tx/${res.txRef}`);

const [balC2, balP2] = await Promise.all([
  pub.readContract({ address: ASSET.mint, abi: ERC20, functionName: "balanceOf", args: [consumer] }) as Promise<bigint>,
  pub.readContract({ address: ASSET.mint, abi: ERC20, functionName: "balanceOf", args: [provider] }) as Promise<bigint>,
]);
console.log(`post-settle — consumer ${formatUnits(balC2, ASSET.decimals)} | provider ${formatUnits(balP2, ASSET.decimals)} ${ASSET.symbol}`);
console.log(`\n🟢 PHASE 2 PASS — real x402 'upto' settle confirmed on Plasma testnet 9746. ASSET_MINT=${ASSET.mint}`);
