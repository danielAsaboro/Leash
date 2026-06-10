import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { DeviceCapability, DeviceIdentityProof, SettlementEndpoint } from "@mycelium/shared";
import type {
  PlasmaBudgetAuthorization,
  PlasmaSettlementService,
  SettlementResult as PlasmaResult,
} from "./plasma-settlement.ts";
import type { SolanaSettlementService, SettlementResult as SolanaResult } from "./solana-settlement.ts";

type RailResult = PlasmaResult | SolanaResult;
export type BudgetAuthorization =
  | { network: "plasma"; authorization: PlasmaBudgetAuthorization }
  | { network: "none" };
export type BudgetAuthorizationResponse =
  | { ok: true; authorization: BudgetAuthorization }
  | { ok: false; reason: string };

export interface SettlementRail {
  ready(): Promise<void>;
  payoutEndpoint(): SettlementEndpoint | null;
  online(): boolean;
  accepts(rail: SettlementEndpoint): boolean;
  settle(provider: string, tokens: number, recipient: SettlementEndpoint): Promise<RailResult>;
}

/**
 * Multi-rail settlement manager: advertise every local payout rail, remember every peer's
 * advertised rails, and settle delegated compute with a deterministic preference order:
 * Plasma first, Solana fallback.
 */
export class SettlementManager {
  private readonly rails: SettlementRail[];
  private readonly recipients = new Map<string, SettlementEndpoint[]>();
  private readonly plasma?: PlasmaSettlementService;

  constructor(opts: { plasma?: PlasmaSettlementService | SettlementRail; solana?: SolanaSettlementService | SettlementRail }) {
    this.rails = [opts.plasma, opts.solana].filter(Boolean) as SettlementRail[];
    this.plasma = opts.plasma instanceof Object && "authorize" in (opts.plasma as object) ? opts.plasma as PlasmaSettlementService : undefined;
  }

  async ready(): Promise<void> {
    await Promise.all(this.rails.map((r) => r.ready()));
  }

  online(): boolean {
    return this.rails.some((r) => r.online());
  }

  payoutEndpoints(): SettlementEndpoint[] {
    return this.rails.map((r) => r.payoutEndpoint()).filter((x): x is SettlementEndpoint => Boolean(x));
  }

  noteCapability(cap: DeviceCapability): void {
    const provider = cap.providerPublicKey;
    if (!provider) return;
    const rails = cap.settlements ?? (cap.settlement ? [cap.settlement] : []);
    this.recipients.set(provider, rails);
  }

  /**
   * Pre-authorize a real compute budget before the run starts. Today that is Plasma x402 `upto`
   * when the peer advertises an x402-capable Plasma rail; otherwise no pre-auth path exists and
   * settlement falls back to the post-run rail path.
   */
  async authorizeBudget(provider: string, requestedBudget?: number): Promise<BudgetAuthorizationResponse> {
    const remoteRails = this.recipients.get(provider) ?? [];
    const remotePlasma = remoteRails.find((r) => this.plasma?.accepts(r) && r.x402?.scheme === "upto");
    if (!this.plasma || !this.plasma.online() || !remotePlasma) return { ok: true, authorization: { network: "none" } };
    const result = await this.plasma.authorize(provider, requestedBudget, remotePlasma);
    if (!result.ok) return result;
    return { ok: true, authorization: { network: "plasma", authorization: result.authorization } };
  }

  /** Metered: sign a fresh Permit2 witness for an escalated cumulative cap on the provider's Plasma rail. */
  async signTier(
    provider: string,
    cumulativeAmount: number,
  ): Promise<{ ok: true; payer: string; paymentPayload: PaymentPayload; accepted: PaymentRequirements } | { ok: false; reason: string }> {
    const remoteRails = this.recipients.get(provider) ?? [];
    const remotePlasma = remoteRails.find((r) => this.plasma?.accepts(r) && r.x402?.scheme === "upto");
    if (!this.plasma || !this.plasma.online() || !remotePlasma) return { ok: false, reason: "no Plasma x402 rail for provider" };
    return this.plasma.signTier(provider, remotePlasma, cumulativeAmount);
  }

  /** Metered: reserve the session float cap WITHOUT signing a payload (rungs are signed via signTier). */
  async reserveBudgetOnly(provider: string, requestedBudget?: number): Promise<BudgetAuthorizationResponse> {
    const remoteRails = this.recipients.get(provider) ?? [];
    const remotePlasma = remoteRails.find((r) => this.plasma?.accepts(r) && r.x402?.scheme === "upto");
    if (!this.plasma || !this.plasma.online() || !remotePlasma) return { ok: true, authorization: { network: "none" } };
    const result = await this.plasma.reserveBudgetOnly(provider, requestedBudget, remotePlasma);
    if (!result.ok) return result;
    return { ok: true, authorization: { network: "plasma", authorization: result.authorization } };
  }

  async settleAuthorized(auth: BudgetAuthorization, tokens: number): Promise<RailResult | null> {
    if (auth.network === "none") return null;
    if (auth.network === "plasma" && this.plasma) return this.plasma.capture(auth.authorization, tokens);
    return null;
  }

  releaseAuthorized(auth: BudgetAuthorization): boolean {
    if (auth.network === "none") return true;
    return auth.network === "plasma" && this.plasma ? this.plasma.release(auth.authorization) : false;
  }

  async finalizeAuthorized(auth: BudgetAuthorization, actualAmount: number, txRef: string): Promise<RailResult | null> {
    if (auth.network === "none") return null;
    if (auth.network === "plasma" && this.plasma) return this.plasma.finalize(auth.authorization, actualAmount, txRef);
    return null;
  }

  plasmaService(): PlasmaSettlementService | undefined {
    return this.plasma;
  }

  /** Phase 4 — sign the wallet↔provider-key binding on the Plasma rail (null if no Plasma rail online). */
  async signIdentityBinding(providerPublicKey: string): Promise<DeviceIdentityProof | null> {
    if (!this.plasma || !this.plasma.online()) return null;
    return this.plasma.signIdentityBinding(providerPublicKey);
  }

  async settle(provider: string, tokens: number): Promise<RailResult> {
    const remoteRails = this.recipients.get(provider) ?? [];
    let lastFailure: RailResult | null = null;
    for (const local of this.rails) {
      if (!local.online()) continue;
      const remote = remoteRails.find((r) => local.accepts(r));
      if (!remote) continue;
      const res = await local.settle(provider, tokens, remote);
      if (res.ok) return res;
      lastFailure = res;
    }
    return lastFailure ?? { ok: false, reason: "provider has no compatible payout rail" };
  }
}
