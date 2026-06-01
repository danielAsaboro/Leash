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
  /** If set, only this consumer public key may connect (firewall allow-list). */
  allowedConsumer?: string;
  audit?: AuditLog;
}

/** Start the provider and return its public key (give this to the consumer). */
export async function startProvider({ seed, allowedConsumer, audit }: StartProviderParams = {}): Promise<{ publicKey: string }> {
  if (seed) process.env["QVAC_HYPERSWARM_SEED"] = seed;
  const res = await startQVACProvider({
    firewall: allowedConsumer ? { mode: "allow", publicKeys: [allowedConsumer] } : undefined,
  });
  if (!res.success || !res.publicKey) {
    throw new Error(`startQVACProvider failed: ${res.error ?? "no publicKey returned"}`);
  }
  audit?.record({
    event: "delegation",
    extra: { role: "provider", publicKey: res.publicKey, firewall: Boolean(allowedConsumer), deterministicSeed: Boolean(seed) },
  });
  return { publicKey: res.publicKey };
}
