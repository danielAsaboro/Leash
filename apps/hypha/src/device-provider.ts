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

/**
 * PURE: the SDK firewall allow-list = the paired `union` MINUS consumer keys whose transient
 * revocation has not yet expired. The metered watchdog uses this to CUT a stalled consumer's live
 * link (a stop→start drops the connection) WITHOUT unpairing it — once `now` passes the expiry the
 * key auto-re-admits, so the cut is a cooldown, not a `forget`. Exported for the unit smoke.
 */
export function effectiveAllow(union: ReadonlySet<string>, revoked: ReadonlyMap<string, number>, now: number): Set<string> {
  const out = new Set(union);
  for (const [key, expiry] of revoked) if (expiry > now) out.delete(key);
  return out;
}

/** PURE: drop transient revocations that have expired so the map can't grow unbounded. Mutates `revoked`. */
export function pruneExpiredRevocations(revoked: Map<string, number>, now: number): void {
  for (const [key, expiry] of revoked) if (expiry <= now) revoked.delete(key);
}

export class DeviceProvider {
  private publicKey: string | null = null;
  private readonly perMesh = new Map<string, Set<string>>();
  private currentAllow = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  /** consumerPublicKey → expiry (ms). A live, non-destructive firewall cutoff (metered watchdog). */
  private readonly transientRevoked = new Map<string, number>();

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
      const allow = this.effective();
      const { publicKey } = await startProvider({ seed: this.seed, audit: this.audit, allowedConsumers: [...allow] });
      this.publicKey = publicKey;
      this.currentAllow = allow;
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

  /** The effective allow-list: paired union minus non-expired transient revocations (prunes expired). */
  private effective(): Set<string> {
    const now = Date.now();
    pruneExpiredRevocations(this.transientRevoked, now);
    return effectiveAllow(this.union(), this.transientRevoked, now);
  }

  /**
   * Transiently CUT a consumer's live serve link for `ttlMs` WITHOUT unpairing it (no removeWriter,
   * no tombstone, stays in the pairing allow-list). A stop→start drops its current connection; it
   * auto-re-admits after the TTL on the next reconcile, so a stalled-but-paired peer can reconnect
   * for a fresh session. This is the metered watchdog's connection-level cutoff (on top of force-settle).
   */
  async transientRevoke(consumerPublicKey: string, ttlMs: number): Promise<void> {
    if (!consumerPublicKey || !(ttlMs > 0)) return;
    this.transientRevoked.set(consumerPublicKey, Date.now() + ttlMs);
    this.audit.record({ event: "note", extra: { role: "device-provider", phase: "transient-revoke", consumer: consumerPublicKey.slice(0, 16), ttlMs } });
    await this.reconcile();
  }

  /** Stop→start the SDK provider with the new union allow-list, ONLY when it changed. Serialized. */
  private async reconcile(): Promise<void> {
    await (this.chain = this.chain.then(async () => {
      const desired = this.effective();
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
