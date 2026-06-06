/**
 * Delegated-inference provider (Layer 1 — Mesh).
 *
 * Wraps `startQVACProvider` (proven in spike/03-p2p-provider.ts). The hub (the
 * Mac / "strong brain") starts a provider; weak devices delegate heavy inference
 * to it over the Noise-encrypted Holepunch/Hyperswarm link. A 64-hex `seed` gives
 * the provider a deterministic identity (stable public key across restarts — handy
 * for CI / repeatable demos); `allowedConsumer` enables the firewall allow-list.
 */
import { startQVACProvider } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";

export interface StartProviderParams {
  /** 64-char hex seed for a deterministic provider identity. Sets QVAC_HYPERSWARM_SEED. */
  seed?: string;
  /** If set, only this consumer public key may connect (single-entry firewall allow-list). */
  allowedConsumer?: string;
  /**
   * Full firewall allow-list of consumer public keys (Hypha closed-mesh: the paired
   * members' gossiped `consumerPublicKey`s). Merged with `allowedConsumer`. When the
   * resulting list is non-empty the provider runs in allow mode and serves ONLY these
   * keys. NOTE: `startQVACProvider` is idempotent and has no dynamic firewall update —
   * to change the list, call `stopQVACProvider()` first, then `startProvider()` again.
   */
  allowedConsumers?: string[];
  audit?: AuditLog;
}

/** Start the provider and return its public key (give this to the consumer). */
export async function startProvider({ seed, allowedConsumer, allowedConsumers, audit }: StartProviderParams = {}): Promise<{ publicKey: string }> {
  if (seed) process.env["QVAC_HYPERSWARM_SEED"] = seed;
  // An explicit allow-list (even an EMPTY array) means closed-mesh: allow mode serves ONLY
  // the listed keys, so `[]` serves no one (Hypha's safe default before peers are known).
  // No allow-list argument at all = open (back-compat with the hub/edge demos).
  const explicit = allowedConsumers !== undefined || allowedConsumer !== undefined;
  const publicKeys = [...new Set([...(allowedConsumers ?? []), ...(allowedConsumer ? [allowedConsumer] : [])])];
  const res = await startQVACProvider({
    firewall: explicit ? { mode: "allow", publicKeys } : undefined,
  });
  if (!res.success || !res.publicKey) {
    throw new Error(`startQVACProvider failed: ${res.error ?? "no publicKey returned"}`);
  }
  audit?.record({
    event: "delegation",
    extra: { role: "provider", publicKey: res.publicKey, firewall: publicKeys.length, deterministicSeed: Boolean(seed) },
  });
  return { publicKey: res.publicKey };
}
