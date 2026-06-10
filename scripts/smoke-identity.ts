/**
 * Pure-logic smoke for Phase 4 costly-identity (apps/hypha/src/plasma-settlement.ts + packages/shared).
 * REAL crypto, no mocks: a real ethers Wallet signs the wallet↔provider-key binding and we recover it;
 * a real ERC20 Transfer log (the exact shape decoded live on 2026-06-10) is matched against payee+amount.
 *
 *   npm run smoke:identity
 */
import assert from "node:assert/strict";
import { Wallet, verifyMessage } from "ethers";
import { identityBindingMessage } from "../packages/shared/src/index.ts";
import { transferLogMatches, verifyIdentityProof } from "../apps/hypha/src/plasma-settlement.ts";

// ── Wallet↔provider-key binding round-trip (the costly-identity anchor) ──────────────────────────
// Well-known anvil/hardhat account #0 (deterministic — not random): address 0xf39Fd6…92266.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new Wallet(PK);
const providerKey = "a92e01257728a3bcff2c9c1bff6f12bd3985774c059997c873257cf5724cde06"; // a real provider-key shape
const message = identityBindingMessage(providerKey, wallet.address, "plasma");
const signature = await wallet.signMessage(message);
const proof = { providerPublicKey: providerKey, wallet: wallet.address, network: "plasma" as const, signature };

assert.equal(verifyMessage(message, signature).toLowerCase(), wallet.address.toLowerCase(), "signer recovers to the wallet");
assert.equal(verifyIdentityProof(proof, providerKey, wallet.address), true, "valid binding verifies (recovered == advertised payee)");
// Casing must not matter (checksum vs lower-case advertised recipient).
assert.equal(verifyIdentityProof(proof, providerKey, wallet.address.toLowerCase()), true, "binding verifies regardless of address casing");
// Tamper: a different wallet than the one bound is rejected.
assert.equal(verifyIdentityProof(proof, providerKey, "0x0000000000000000000000000000000000000001"), false, "wrong expected wallet rejected");
// Tamper: claim a DIFFERENT provider key while keeping the same signature → message changes → recovery fails.
assert.equal(
  verifyIdentityProof({ ...proof, providerPublicKey: "attacker-other-key" }, "attacker-other-key", wallet.address),
  false,
  "a signature cannot be re-bound to a different provider key (anti-replay of the proof)",
);
// Malformed / unsupported.
assert.equal(verifyIdentityProof(undefined, providerKey, wallet.address), false, "missing proof rejected");
assert.equal(verifyIdentityProof({ ...proof, signature: "0xdeadbeef" }, providerKey, wallet.address), false, "garbage signature rejected (no throw)");
assert.equal(verifyIdentityProof({ ...proof, network: "solana" as "plasma" }, providerKey, wallet.address), false, "non-EVM network rejected");

// ── ERC20 Transfer-log decode (the only place the asset movement is visible — settle.to is the proxy) ──
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const mint = "0x502012b361AebCE43b26Ec812B74D9a51dB4D412";   // USDT0 mint (live rail)
const payee = "0x2aaC8FFB2f1F0970dF34Bd2d95710645E6a2E3Bd";  // provider/payee wallet (live rail)
const payer = "0xD66ee243D74A7b469D19ECFe88589d8f282a4e9f";  // consumer/payer wallet (live rail)
const pad32 = (a: string): string => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const u256 = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const transferLog = { address: mint, topics: [TRANSFER, pad32(payer), pad32(payee)], data: u256(512) };

assert.equal(transferLogMatches(transferLog, mint, payee, 512), true, "exact Transfer(512 → payee) matches");
assert.equal(transferLogMatches(transferLog, mint, payee, 500), true, "value above min still matches");
assert.equal(transferLogMatches(transferLog, mint, payee, 513), false, "value below requested min rejected");
assert.equal(transferLogMatches(transferLog, mint, payer, 512), false, "transfer to a different address rejected");
assert.equal(transferLogMatches(transferLog, "0x0000000000000000000000000000000000000002", payee, 512), false, "wrong asset mint rejected");
assert.equal(transferLogMatches({ ...transferLog, topics: ["0xdeadbeef", pad32(payer), pad32(payee)] }, mint, payee, 512), false, "non-Transfer topic rejected");
assert.equal(transferLogMatches(null, mint, payee, 512), false, "null log rejected (no throw)");
assert.equal(transferLogMatches({ address: mint, topics: [TRANSFER], data: u256(512) }, mint, payee, 512), false, "truncated topics rejected");

console.log("✅ identity — wallet↔key binding sign/recover · anti-replay · ERC20 Transfer-log decode (payee+amount) — GO");
process.exit(0);
