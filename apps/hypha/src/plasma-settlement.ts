/**
 * Plasma/EVM x402 settlement for delegated compute.
 *
 * The old direct-transfer path bounded spend AFTER the run. This rail upgrades Plasma to a real
 * x402 `upto` flow: reserve a spend cap first, sign a Permit2 authorization for that CAP, verify
 * it against the provider's facilitator, then settle the smaller ACTUAL amount after the decode.
 *
 * Transport caveat: delegated compute still rides QVAC directly, not HTTP 402, so this is an
 * out-of-band x402 budget + settlement around the run rather than a server-issued 402 challenge.
 * The budget is still real: the payer signs a concrete x402 authorization capped at `amount`.
 */
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import WalletAccountEvmX402Facilitator from "@semanticio/wdk-wallet-evm-x402-facilitator";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { UptoEvmScheme as UptoEvmClient } from "@x402/evm/upto/client";
import { UptoEvmScheme as UptoEvmFacilitator } from "@x402/evm/upto/facilitator";
import { verifyMessage } from "ethers";
import { SpendGuard, type PayFn, type PriceSheet, type SpendLimits } from "@mycelium/mesh";
import { identityBindingMessage } from "@mycelium/shared";
import type { SettlementEndpoint, DeviceIdentityProof } from "@mycelium/shared";

export interface PlasmaSettlementConfig {
  enabled: boolean;
  rpcUrl: string;
  mnemonic?: string;
  asset: { symbol: string; mint: string; decimals: number; networkId?: string };
  price: PriceSheet;
  limits: SpendLimits;
  initialFloat: number;
  /** Validity window for one signed compute budget (x402 `maxTimeoutSeconds`). */
  budgetTimeoutSeconds?: number;
}

export type SettlementResult =
  | { ok: true; network: "plasma"; amount: number; txRef: string; recipient: string; asset: string; mint: string; mode: "x402-upto" }
  | { ok: false; reason: string };

export interface PlasmaBudgetAuthorization {
  provider: string;
  reservationId: string;
  maxAmount: number;
  payer: string;
  recipient: SettlementEndpoint;
  paymentPayload: PaymentPayload;
  accepted: PaymentRequirements;
}

export type BudgetAuthorizationResult =
  | { ok: true; authorization: PlasmaBudgetAuthorization }
  | { ok: false; reason: string };

export interface PlasmaVerifiedBudget {
  provider: string;
  maxAmount: number;
  recipient: SettlementEndpoint;
  paymentPayload: PaymentPayload;
  accepted: PaymentRequirements;
}

export type BudgetVerificationResult =
  | { ok: true; verification: PlasmaVerifiedBudget }
  | { ok: false; reason: string };

const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

/** keccak256("Transfer(address,address,uint256)") — the ERC20 Transfer event topic0. */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Minimal shape of an EVM log we decode (a subset of ethers' `Log`). */
export interface RawEvmLog {
  address?: string;
  topics?: ReadonlyArray<string>;
  data?: string;
}

/**
 * PURE: does this log encode an ERC20 `Transfer(assetMint → expectedPayee, value ≥ minAmount)`?
 * Phase 4 — the settle tx's direct `to` is the x402 upto proxy, so the asset movement is ONLY visible
 * in this Transfer log (topics[2] = left-padded recipient, data = uint256 amount). Exported for the
 * unit smoke. Case-insensitive on addresses; tolerant of malformed logs (returns false, never throws).
 */
export function transferLogMatches(
  log: RawEvmLog | null | undefined,
  assetMint: string,
  expectedPayee: string,
  minAmount: number | bigint,
): boolean {
  if (!log || !log.topics || log.topics.length < 3 || !assetMint || !expectedPayee) return false;
  if ((log.topics[0] ?? "").toLowerCase() !== ERC20_TRANSFER_TOPIC) return false;
  if ((log.address ?? "").toLowerCase() !== assetMint.toLowerCase()) return false;
  // topics[2] is the 32-byte left-padded recipient address; the last 40 hex chars are the address.
  const to = "0x" + (log.topics[2] ?? "").slice(-40);
  if (to.toLowerCase() !== expectedPayee.toLowerCase()) return false;
  let value: bigint;
  try { value = BigInt(log.data ?? "0x0"); } catch { return false; }
  return value >= BigInt(minAmount);
}

/**
 * PURE: verify a provider's wallet↔key binding (Phase 4). Recovers the signer of the canonical
 * binding message and requires it to equal both the advertised payee wallet and the proof's claimed
 * wallet, and the proof's providerPublicKey to equal the advertised provider key. Returns false
 * (never throws) on any mismatch / malformed proof. EVM (`plasma`) only for now.
 */
export function verifyIdentityProof(
  proof: DeviceIdentityProof | undefined,
  expectedProviderKey: string,
  expectedWallet: string,
): boolean {
  if (!proof || !proof.signature || !proof.wallet || !expectedWallet) return false;
  if (proof.network !== "plasma") return false;
  if (proof.providerPublicKey !== expectedProviderKey) return false;
  if (proof.wallet.toLowerCase() !== expectedWallet.toLowerCase()) return false;
  try {
    const recovered = verifyMessage(identityBindingMessage(proof.providerPublicKey, proof.wallet, proof.network), proof.signature);
    return recovered.toLowerCase() === expectedWallet.toLowerCase();
  } catch {
    return false;
  }
}

export class PlasmaSettlementService {
  private readonly enabled: boolean;
  private readonly guard: SpendGuard | null;
  private readonly endpoint: SettlementEndpoint | null;
  private readonly accountPromise: Promise<Awaited<ReturnType<WalletManagerEvm["getAccount"]>>> | null;
  private readonly xclientPromise: Promise<x402Client> | null;
  private readonly facilitatorPromise: Promise<x402Facilitator> | null;
  private readonly networkId: string;

  constructor(private readonly cfg: PlasmaSettlementConfig) {
    this.enabled = Boolean(cfg.enabled && cfg.rpcUrl && cfg.mnemonic?.trim() && cfg.asset.mint);
    this.networkId = cfg.asset.networkId ?? "eip155:9745";
    if (!this.enabled) {
      this.guard = null;
      this.endpoint = null;
      this.accountPromise = null;
      this.xclientPromise = null;
      this.facilitatorPromise = null;
      return;
    }
    const wallet = new WalletManagerEvm(cfg.mnemonic as string, { provider: cfg.rpcUrl });
    this.accountPromise = wallet.getAccount(0);
    this.endpoint = {
      network: "plasma",
      networkId: this.networkId,
      asset: cfg.asset.symbol,
      mint: cfg.asset.mint,
      decimals: cfg.asset.decimals,
      recipient: "0x",
      x402: {
        version: 2,
        scheme: "upto",
        facilitator: "0x",
        maxTimeoutSeconds: cfg.budgetTimeoutSeconds ?? 900,
        pricePerKiloToken: cfg.price.perKiloToken,
      },
    };
    this.xclientPromise = this.accountPromise.then(async (account) => {
      const signer = {
        address: (await account.getAddress()) as `0x${string}`,
        signTypedData: async (typed: {
          domain: Record<string, unknown>;
          types: Record<string, unknown>;
          primaryType: string;
          message: Record<string, unknown>;
        }) => await account.signTypedData({
          domain: typed.domain as never,
          types: typed.types as never,
          message: typed.message,
        }) as `0x${string}`,
      };
      return new x402Client().register(this.networkId as `${string}:${string}`, new UptoEvmClient(signer, { rpcUrl: cfg.rpcUrl }));
    });
    this.facilitatorPromise = this.accountPromise.then(async (account) => {
      const signer = new WalletAccountEvmX402Facilitator(account as never);
      // Upstream bug (@semanticio/wdk-wallet-evm-x402-facilitator): readContract does
      // `contract[fn](...args)` on a read-only provider with no `from`. Two problems for the
      // verify-time simulation of the upto proxy's `settle`:
      //   1. ethers v6 treats a NONPAYABLE fn as a send → "contract runner does not support
      //      sending transactions". The x402 facilitator calls readContract expecting an
      //      eth_call, so we force `.staticCall`.
      //   2. The proxy reverts `UnauthorizedFacilitator` unless `msg.sender == facilitator`.
      //      The facilitator IS this signer's account, so we set `from` to its address.
      const ethersProvider = (account as unknown as { _provider: unknown })._provider;
      const fromAddr = await account.getAddress();
      (signer as unknown as { readContract: (a: { address: string; abi: unknown; functionName: string; args?: unknown[] }) => Promise<unknown> }).readContract =
        async ({ address, abi, functionName, args = [] }) => {
          const { Contract } = await import("ethers");
          const contract = new Contract(address as string, abi as never, ethersProvider as never);
          return contract.getFunction(functionName).staticCall(...args, { from: fromAddr });
        };
      return new x402Facilitator().register(this.networkId as `${string}:${string}`, new UptoEvmFacilitator(signer));
    });
    const pay: PayFn = async () => {
      throw new Error("direct pay() is not used on the Plasma x402 rail");
    };
    this.guard = new SpendGuard(cfg.limits, cfg.price, new Set<string>(), cfg.initialFloat, pay);
  }

  async ready(): Promise<void> {
    if (!this.accountPromise || !this.endpoint) return;
    const address = await (await this.accountPromise).getAddress();
    this.endpoint.recipient = address;
    if (this.endpoint.x402) this.endpoint.x402.facilitator = address;
    await Promise.all([this.xclientPromise, this.facilitatorPromise]);
  }

  payoutEndpoint(): SettlementEndpoint | null {
    return this.endpoint;
  }

  online(): boolean {
    return this.enabled && this.guard !== null && this.endpoint !== null;
  }

  accepts(rail: SettlementEndpoint): boolean {
    return (
      this.online() &&
      rail.network === "plasma" &&
      rail.mint.toLowerCase() === this.cfg.asset.mint.toLowerCase() &&
      (!this.cfg.asset.networkId || !rail.networkId || rail.networkId === this.cfg.asset.networkId)
    );
  }

  /** The caller-visible max CAP per delegated run on this rail. */
  maxBudget(): number {
    return this.cfg.limits.maxPerTx;
  }

  amountForTokens(tokens: number): number {
    return Math.ceil((tokens / 1000) * this.cfg.price.perKiloToken);
  }

  /** This rail's asset contract address (the ERC20 mint), used to scope on-chain receipt verification. */
  assetMint(): string {
    return this.cfg.asset.mint;
  }

  /** txHash|payee|mint|minAmount → CONFIRMED. Only positive verdicts cached (txHashes are immutable). */
  private readonly txVerifyCache = new Map<string, boolean>();

  /**
   * Phase 4 — on-chain receipt verification. Confirms `txHash` is a SUCCESSFUL tx that emitted an ERC20
   * `Transfer` of `assetMint` to `expectedPayee` for at least `minAmount`. The settle tx's direct `to`
   * is the x402 upto proxy, NOT the payee, so we read the Transfer LOG (not `tx.to`). Null-safe — any
   * RPC error / missing receipt / revert / wrong-payee returns false. Used by reputation to count a
   * receipt only when its money provably moved on-chain to the provider's bound wallet.
   */
  async verifyTxSettled(txHash: string, expectedPayee: string, assetMint: string, minAmount: number): Promise<boolean> {
    if (!this.online() || !this.accountPromise) return false;
    if (typeof txHash !== "string" || !txHash.startsWith("0x") || !expectedPayee || !assetMint) return false;
    const key = `${txHash.toLowerCase()}|${expectedPayee.toLowerCase()}|${assetMint.toLowerCase()}|${minAmount}`;
    if (this.txVerifyCache.get(key)) return true;
    try {
      const account = await this.accountPromise;
      const provider = (account as unknown as { _provider?: { getTransactionReceipt?: (h: string) => Promise<{ status?: number | null; logs?: ReadonlyArray<RawEvmLog> } | null> } })._provider;
      if (!provider?.getTransactionReceipt) return false;
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return false; // not mined, or reverted
      const ok = (receipt.logs ?? []).some((log) => transferLogMatches(log, assetMint, expectedPayee, minAmount));
      if (ok) this.txVerifyCache.set(key, true);
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Phase 4 — sign the costly-identity binding of `providerPublicKey` ↔ this rail's payout wallet,
   * using the EVM wallet's asymmetric `personal_sign` (NOT the HMAC receipt sig). Advertised as
   * `identityProof` on the device capability; a consumer recovers the signer to prove the wallet that
   * receives settlement controls this provider key. Returns null if the rail is offline.
   */
  async signIdentityBinding(providerPublicKey: string): Promise<DeviceIdentityProof | null> {
    if (!this.online() || !this.accountPromise) return null;
    try {
      const account = await this.accountPromise;
      const wallet = await account.getAddress();
      const network = "plasma" as const;
      // wdk's signing account exposes EIP-191 personal_sign as `sign(message)` (NOT `signMessage`, which
      // is the inner ethers signer); ethers `verifyMessage` recovers it on the consumer side.
      const signature = await (account as unknown as { sign: (m: string) => Promise<string> }).sign(
        identityBindingMessage(providerPublicKey, wallet, network),
      );
      return { providerPublicKey, wallet, network, signature };
    } catch {
      return null;
    }
  }

  private buildRequirements(recipient: SettlementEndpoint, amount: number): PaymentRequirements {
    return {
      scheme: recipient.x402?.scheme ?? "upto",
      network: (recipient.networkId ?? this.networkId) as `${string}:${string}`,
      asset: recipient.mint,
      amount: String(amount),
      payTo: recipient.recipient,
      maxTimeoutSeconds: recipient.x402?.maxTimeoutSeconds ?? this.cfg.budgetTimeoutSeconds ?? 900,
      extra: {
        facilitatorAddress: recipient.x402?.facilitator ?? recipient.recipient,
      },
    };
  }

  private buildPaymentRequired(provider: string, requirements: PaymentRequirements): PaymentRequired {
    return {
      x402Version: 2,
      resource: {
        url: `hypha://delegated-compute/${provider}`,
        serviceName: "hypha",
        description: "Hypha delegated compute budget",
        mimeType: "application/json",
        tags: ["delegated-compute", "mesh", "x402"],
      },
      accepts: [requirements],
    };
  }

  private async ensurePermit2Allowance(amount: number): Promise<void> {
    const account = await this.accountPromise!;
    const allowance = await account.getAllowance(this.cfg.asset.mint, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
    if (allowance >= BigInt(amount)) return;
    await account.approve({
      token: this.cfg.asset.mint,
      spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      amount: amount > 1_000_000 ? MAX_UINT256 : BigInt(amount),
    });
  }

  async authorize(provider: string, requestedBudget: number | undefined, recipient: SettlementEndpoint): Promise<BudgetAuthorizationResult> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    if (!this.accepts(recipient)) return { ok: false, reason: "provider has no compatible Plasma payout rail" };
    if (!recipient.x402 || recipient.x402.scheme !== "upto" || !recipient.x402.facilitator) {
      return { ok: false, reason: "provider Plasma rail is not x402-enabled" };
    }
    this.guard!.allow(provider);
    const desiredBudget = Math.min(
      Math.max(1, Math.floor(requestedBudget ?? this.cfg.limits.maxPerTx)),
      this.cfg.limits.maxPerTx,
    );
    const reserved = this.guard!.reserveBudget({ provider, amount: desiredBudget });
    if (!reserved.ok) return reserved;
    if (!reserved.reservationId) return { ok: false, reason: "failed to reserve compute budget" };
    try {
      await this.ensurePermit2Allowance(desiredBudget);
      const requirements = this.buildRequirements(recipient, desiredBudget);
      const paymentRequired = this.buildPaymentRequired(provider, requirements);
      const payload = await (await this.xclientPromise!).createPaymentPayload(paymentRequired);
      return {
        ok: true,
        authorization: {
          provider,
          reservationId: reserved.reservationId,
          maxAmount: desiredBudget,
          payer: await (await this.accountPromise!).getAddress(),
          recipient,
          paymentPayload: payload,
          accepted: requirements,
        },
      };
    } catch (err) {
      this.guard!.releaseBudget(reserved.reservationId);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Metered escalation: produce a FRESH x402 "upto" Permit2 witness for a higher CUMULATIVE cap,
   * WITHOUT a new reservation or approve. The session's single SpendGuard reservation already bounds
   * the float and the max-uint Permit2 allowance already covers every rung, so each advance is
   * signature-only (no mid-stream approve tx). Reuses the authorize() signing path.
   */
  async signTier(
    provider: string,
    recipient: SettlementEndpoint,
    cumulativeAmount: number,
  ): Promise<{ ok: true; payer: string; paymentPayload: PaymentPayload; accepted: PaymentRequirements } | { ok: false; reason: string }> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    if (!this.accepts(recipient)) return { ok: false, reason: "provider has no compatible Plasma payout rail" };
    if (!recipient.x402 || recipient.x402.scheme !== "upto" || !recipient.x402.facilitator) {
      return { ok: false, reason: "provider Plasma rail is not x402-enabled" };
    }
    if (!Number.isFinite(cumulativeAmount) || cumulativeAmount <= 0) return { ok: false, reason: "invalid advance amount" };
    try {
      await this.ensurePermit2Allowance(cumulativeAmount);
      const requirements = this.buildRequirements(recipient, cumulativeAmount);
      const paymentRequired = this.buildPaymentRequired(provider, requirements);
      const payload = await (await this.xclientPromise!).createPaymentPayload(paymentRequired);
      return { ok: true, payer: await (await this.accountPromise!).getAddress(), paymentPayload: payload, accepted: requirements };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Metered: reserve the session float CAP and ensure the Permit2 allowance, but DO NOT create a
   * payment payload — the rungs are signed separately via signTier(). Returns a BudgetAuthorization
   * whose only meaningful field for the metered path is `reservationId` (finalize() captures by id;
   * the placeholder paymentPayload is never settled). This avoids creating an unused payload on the
   * x402 client alongside the rung payloads.
   */
  async reserveBudgetOnly(provider: string, requestedBudget: number | undefined, recipient: SettlementEndpoint): Promise<BudgetAuthorizationResult> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    if (!this.accepts(recipient)) return { ok: false, reason: "provider has no compatible Plasma payout rail" };
    if (!recipient.x402 || recipient.x402.scheme !== "upto" || !recipient.x402.facilitator) {
      return { ok: false, reason: "provider Plasma rail is not x402-enabled" };
    }
    this.guard!.allow(provider);
    const desiredBudget = Math.min(Math.max(1, Math.floor(requestedBudget ?? this.cfg.limits.maxPerTx)), this.cfg.limits.maxPerTx);
    const reserved = this.guard!.reserveBudget({ provider, amount: desiredBudget });
    if (!reserved.ok) return reserved;
    if (!reserved.reservationId) return { ok: false, reason: "failed to reserve compute budget" };
    try {
      await this.ensurePermit2Allowance(desiredBudget);
      return {
        ok: true,
        authorization: {
          provider,
          reservationId: reserved.reservationId,
          maxAmount: desiredBudget,
          payer: await (await this.accountPromise!).getAddress(),
          recipient,
          paymentPayload: {} as PaymentPayload, // placeholder; metered settles per-rung, finalize() uses only reservationId
          accepted: this.buildRequirements(recipient, desiredBudget),
        },
      };
    } catch (err) {
      this.guard!.releaseBudget(reserved.reservationId);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async capture(auth: PlasmaBudgetAuthorization, tokens: number): Promise<SettlementResult> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    const actualAmount = this.amountForTokens(tokens);
    const result = await this.guard!.captureBudget(
      auth.reservationId,
      actualAmount,
      async (_provider, amount, authorization) => {
        const settleRequirements: PaymentRequirements = {
          ...authorization.accepted,
          amount: String(amount),
        };
        const settled = await (await this.facilitatorPromise!).settle(authorization.paymentPayload, settleRequirements);
        if (!settled.success) {
          throw new Error(settled.errorMessage ?? settled.errorReason ?? "x402 settle failed");
        }
        return { txRef: settled.transaction };
      },
      auth,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      network: "plasma",
      amount: result.amount,
      txRef: result.txRef as string,
      recipient: auth.recipient.recipient,
      asset: auth.recipient.asset,
      mint: auth.recipient.mint,
      mode: "x402-upto",
    };
  }

  release(auth: PlasmaBudgetAuthorization): boolean {
    if (!this.online()) return false;
    return this.guard!.releaseBudget(auth.reservationId);
  }

  async finalize(auth: PlasmaBudgetAuthorization, actualAmount: number, txRef: string): Promise<SettlementResult> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    const result = await this.guard!.captureBudget(
      auth.reservationId,
      actualAmount,
      async () => ({ txRef }),
      auth,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      network: "plasma",
      amount: result.amount,
      txRef,
      recipient: auth.recipient.recipient,
      asset: auth.recipient.asset,
      mint: auth.recipient.mint,
      mode: "x402-upto",
    };
  }

  async verifyBudget(
    provider: string,
    maxAmount: number,
    recipient: SettlementEndpoint,
    paymentPayload: PaymentPayload,
    accepted: PaymentRequirements,
  ): Promise<BudgetVerificationResult> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    if (!this.accepts(recipient)) return { ok: false, reason: "provider has no compatible Plasma payout rail" };
    if (!recipient.x402 || recipient.x402.scheme !== "upto" || !recipient.x402.facilitator) {
      return { ok: false, reason: "provider Plasma rail is not x402-enabled" };
    }
    const expected = this.buildRequirements(recipient, maxAmount);
    const mismatch =
      accepted.scheme !== expected.scheme ||
      accepted.network !== expected.network ||
      accepted.asset !== expected.asset ||
      accepted.amount !== expected.amount ||
      accepted.payTo !== expected.payTo ||
      accepted.maxTimeoutSeconds !== expected.maxTimeoutSeconds ||
      accepted.extra?.["facilitatorAddress"] !== expected.extra?.["facilitatorAddress"];
    if (mismatch) return { ok: false, reason: "payment requirements do not match the provider quote" };
    try {
      const verify = await (await this.facilitatorPromise!).verify(paymentPayload, expected);
      if (!verify.isValid) {
        return { ok: false, reason: verify.invalidMessage ?? verify.invalidReason ?? "x402 verification failed" };
      }
      return {
        ok: true,
        verification: {
          provider,
          maxAmount,
          recipient,
          paymentPayload,
          accepted: expected,
        },
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async settleVerified(verification: PlasmaVerifiedBudget, actualAmount: number): Promise<SettlementResult> {
    if (!this.online()) return { ok: false, reason: "Plasma settlement disabled" };
    if (!Number.isFinite(actualAmount) || actualAmount < 0) return { ok: false, reason: "invalid actual amount" };
    if (actualAmount > verification.maxAmount) return { ok: false, reason: "actual amount exceeds reserved budget" };
    if (actualAmount === 0) {
      return {
        ok: true,
        network: "plasma",
        amount: 0,
        txRef: "",
        recipient: verification.recipient.recipient,
        asset: verification.recipient.asset,
        mint: verification.recipient.mint,
        mode: "x402-upto",
      };
    }
    try {
      const settleRequirements: PaymentRequirements = {
        ...verification.accepted,
        amount: String(actualAmount),
      };
      const settled = await (await this.facilitatorPromise!).settle(verification.paymentPayload, settleRequirements);
      if (!settled.success) return { ok: false, reason: settled.errorMessage ?? settled.errorReason ?? "x402 settle failed" };
      return {
        ok: true,
        network: "plasma",
        amount: actualAmount,
        txRef: settled.transaction,
        recipient: verification.recipient.recipient,
        asset: verification.recipient.asset,
        mint: verification.recipient.mint,
        mode: "x402-upto",
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Legacy one-shot settlement entrypoint. For Plasma this now still uses x402 — it just
   * authorizes a CAP equal to the exact intended charge, then captures it immediately.
   */
  async settle(provider: string, tokens: number, recipient: SettlementEndpoint): Promise<SettlementResult> {
    const budget = this.amountForTokens(tokens);
    const auth = await this.authorize(provider, budget, recipient);
    if (!auth.ok) return auth;
    return this.capture(auth.authorization, tokens);
  }
}
