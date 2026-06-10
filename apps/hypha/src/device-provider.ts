/**
 * DeviceProvider — the ONE delegated-inference provider per device + its UNION firewall (spec §4).
 *
 * `startQVACProvider` is process-global (packages/mesh/src/provider.ts): one provider, one
 * firewall allow-list, changed only by stop→start. So a device that belongs to several meshes
 * runs a SINGLE provider whose allow-list is the UNION of the consumer keys it serves across every
 * mesh. Each mesh registers its own desired consumer set here; this object unions them and
 * reconciles the SDK provider only when the union actually changes (a stop→start is not free).
 *
 * Lazy: the provider isn't started until the first mesh comes online (a fresh, unpaired device
 * serves no one — preserving the daemon's existing lazy-mesh behavior). A broadcast-only public
 * mesh registers an EMPTY set; it can never widen the allow-list, which is what makes it safe.
 *
 * Reconciles are serialized on a promise chain so two meshes' updates can't thrash the global
 * provider with interleaved stop→starts.
 */
import { startProvider } from "@mycelium/mesh";
import { stopQVACProvider } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

export class DeviceProvider {
  private publicKey: string | null = null;
  private readonly perMesh = new Map<string, Set<string>>();
  private currentAllow = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly seed: string,
    private readonly audit: AuditLog,
    private readonly onAllowlistChanged?: (providerPublicKey: string, allowedConsumers: Set<string>) => void | Promise<void>,
  ) {}

  /** The device-global provider/consumer public key (null until the first mesh starts it). */
  get selfKey(): string | null {
    return this.publicKey;
  }

  /** Start the provider once (lazy, idempotent). Returns the stable device provider key. */
  async ensureStarted(): Promise<string> {
    await (this.chain = this.chain.then(async () => {
      if (this.publicKey) return;
      const { publicKey } = await startProvider({ seed: this.seed, audit: this.audit, allowedConsumers: [...this.union()] });
      this.publicKey = publicKey;
      this.currentAllow = this.union();
      await this.onAllowlistChanged?.(publicKey, new Set(this.currentAllow));
    }));
    if (!this.publicKey) throw new Error("device provider failed to start");
    return this.publicKey;
  }

  /** Register/replace one mesh's desired consumer set, then reconcile the union firewall. */
  async setMeshConsumers(meshId: string, consumers: Set<string>): Promise<void> {
    this.perMesh.set(meshId, consumers);
    await this.reconcile();
  }

  /** Drop a mesh (left/closed) from the union and reconcile. */
  async removeMesh(meshId: string): Promise<void> {
    if (this.perMesh.delete(meshId)) await this.reconcile();
  }

  private union(): Set<string> {
    const out = new Set<string>();
    for (const s of this.perMesh.values()) for (const k of s) out.add(k);
    return out;
  }

  /** Stop→start the SDK provider with the new union allow-list, ONLY when it changed. Serialized. */
  private async reconcile(): Promise<void> {
    await (this.chain = this.chain.then(async () => {
      const desired = this.union();
      if (this.publicKey && sameSet(desired, this.currentAllow)) return;
      try {
        if (this.publicKey) await stopQVACProvider();
        const { publicKey } = await startProvider({ seed: this.seed, audit: this.audit, allowedConsumers: [...desired] });
        this.publicKey = publicKey;
        this.currentAllow = desired;
        await this.onAllowlistChanged?.(publicKey, new Set(this.currentAllow));
        console.log(`🔒 union firewall — ${desired.size} allowed consumer(s) across ${this.perMesh.size} mesh(es)`);
      } catch (err) {
        this.audit.record({ event: "note", extra: { role: "device-provider", phase: "reconcile-failed", error: String(err) } });
        console.error("⚠️ union firewall reconcile failed:", err);
      }
    }));
  }
}
