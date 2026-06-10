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
import { SpendGuard, type PayFn, type PriceSheet, type SpendLimits } from "@mycelium/mesh";
import type { SettlementEndpoint } from "@mycelium/shared";

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
