/**
 * Solana stablecoin settlement for delegated compute.
 *
 * This is the runtime plug behind the already-tested SpendGuard. It is intentionally optional:
 * when the wallet env is absent, Hypha behaves exactly as before; when present, delegated
 * completions can auto-settle to a peer's advertised Solana payout rail under strict caps.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createTransferInstruction, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { SpendGuard, type PayFn, type PriceSheet, type SpendLimits } from "@mycelium/mesh";
import type { SettlementEndpoint } from "@mycelium/shared";

export interface SolanaSettlementConfig {
  enabled: boolean;
  rpcUrl: string;
  secretKey?: string;
  secretKeyFile?: string;
  asset: { symbol: string; mint: string; decimals: number };
  price: PriceSheet;
  limits: SpendLimits;
  initialFloat: number;
}

export type SettlementResult =
  | { ok: true; network: "solana"; amount: number; txRef: string; recipient: string; asset: string; mint: string }
  | { ok: false; reason: string };

const parseSecretKey = (raw: string): Uint8Array => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("missing Solana secret key");
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("secret key must be a JSON uint8 array");
    return Uint8Array.from(parsed);
  } catch (err) {
    throw new Error(`bad Solana secret key: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export class SolanaSettlementService {
  private readonly enabled: boolean;
  private readonly guard: SpendGuard | null;
  private readonly endpoint: SettlementEndpoint | null;
  private readonly connection: Connection | null;
  private readonly signer: Keypair | null;

  constructor(private readonly cfg: SolanaSettlementConfig) {
    this.enabled = Boolean(
      cfg.enabled &&
      cfg.rpcUrl &&
      cfg.asset.mint &&
      (cfg.secretKey?.trim() || cfg.secretKeyFile?.trim()),
    );
    if (!this.enabled) {
      this.guard = null;
      this.endpoint = null;
      this.connection = null;
      this.signer = null;
      return;
    }
    const raw = cfg.secretKey?.trim() || readFileSync(cfg.secretKeyFile as string, "utf8");
    const signer = Keypair.fromSecretKey(parseSecretKey(raw));
    this.signer = signer;
    this.connection = new Connection(cfg.rpcUrl, "confirmed");
    this.endpoint = {
      network: "solana",
      asset: cfg.asset.symbol,
      mint: cfg.asset.mint,
      decimals: cfg.asset.decimals,
      recipient: signer.publicKey.toBase58(),
    };
    let currentRecipient: SettlementEndpoint | null = null;
    const pay: PayFn = async (_provider, amount) => {
      const recipient = currentRecipient;
      if (!recipient) throw new Error("provider has no Solana payout rail");
      if (!this.connection || !this.signer) throw new Error("Solana settlement disabled");
      const mint = new PublicKey(recipient.mint);
      const owner = this.signer.publicKey;
      const recipientOwner = new PublicKey(recipient.recipient);
      const senderAta = await getOrCreateAssociatedTokenAccount(this.connection, this.signer, mint, owner);
      const recipientAta = await getOrCreateAssociatedTokenAccount(this.connection, this.signer, mint, recipientOwner);
      const tx = new Transaction().add(
        createTransferInstruction(senderAta.address, recipientAta.address, owner, BigInt(amount)),
      );
      const txRef = await sendAndConfirmTransaction(this.connection, tx, [this.signer], { commitment: "confirmed" });
      return { txRef };
    };
    this.guard = new SpendGuard(cfg.limits, cfg.price, new Set<string>(), cfg.initialFloat, pay);
    this._setRecipient = (r: SettlementEndpoint | null) => { currentRecipient = r; };
  }

  private _setRecipient: (r: SettlementEndpoint | null) => void = () => {};

  async ready(): Promise<void> {}

  payoutEndpoint(): SettlementEndpoint | null {
    return this.endpoint;
  }

  online(): boolean {
    return this.enabled && this.guard !== null && this.endpoint !== null;
  }

  accepts(rail: SettlementEndpoint): boolean {
    return this.online() && rail.network === "solana" && rail.mint === this.cfg.asset.mint;
  }

  async settle(provider: string, tokens: number, recipient: SettlementEndpoint): Promise<SettlementResult> {
    if (!this.online()) return { ok: false, reason: "Solana settlement disabled" };
    if (!this.accepts(recipient)) return { ok: false, reason: "provider has no compatible Solana payout rail" };
    this._setRecipient(recipient);
    this.guard!.allow(provider);
    const result = await this.guard!.settleInference({ provider, tokens }).finally(() => this._setRecipient(null));
    if (!result.ok) return result;
    return {
      ok: true,
      network: "solana",
      amount: result.amount,
      txRef: result.txRef as string,
      recipient: recipient.recipient,
      asset: recipient.asset,
      mint: recipient.mint,
    };
  }
}
