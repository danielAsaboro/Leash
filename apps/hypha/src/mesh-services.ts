/**
 * Mesh services — the PER-MESH heartbeat + firewall-contribution + warm pool that run once a
 * device is in a given mesh. Extracted from the daemon so it can be started lazily, and now
 * started ONCE PER MESH (a device holds several memberships — spec §3).
 *
 * What is NOT here anymore: the SDK provider. `startQVACProvider` is process-global (spec §4), so
 * the provider + its UNION firewall live in a single device-level {@link DeviceProvider}. Each
 * mesh only computes ITS desired consumer set and registers it; the DeviceProvider unions across
 * meshes and reconciles the one global provider.
 *
 * A device with no mesh yet (fresh, never paired) runs only the shim + discovery; there are no
 * peers to gossip to or serve, so none of this is needed until it pairs.
 */
import { AuditLog, makeCapability } from "@mycelium/shared";
import type { DeviceCapability, DeviceIdentityProof } from "@mycelium/shared";
import { unionAllowedConsumers } from "@mycelium/mesh";
import type { MeshGraph } from "@mycelium/mesh";
import { WarmPool, type ReputationRanker } from "./warm-pool.ts";
import { localChatAliases } from "./catalog.ts";
import type { Inflight } from "./shim.ts";
import type { DeviceProvider } from "./device-provider.ts";
import type { SettlementManager } from "./settlement-manager.ts";
import { COMPUTE_CLASS, DEVICE_NAME, HEARTBEAT_MS, POWER_STATE, RAM_MB, STALE_MS, WARM_TICK_MS } from "./config.ts";

export interface MeshRuntime {
  meshId: string;
  graph: MeshGraph;
  /** The device-global provider/consumer key (same across every mesh — one provider per device). */
  selfKey: string;
  pool: WarmPool;
  /** Recompute THIS mesh's desired consumer set and push it to the device-global union firewall. */
  reconcileFirewall(): Promise<void>;
  /** Re-advertise this mesh's capability now. */
  advertise(): Promise<void>;
  /** Stop this mesh's timers + warm pool, and drop it from the union firewall. */
  stop(): Promise<void>;
}

export interface StartMeshServicesDeps {
  /** Local mesh handle (the namespace id). */
  meshId: string;
  /** The device-global provider that owns the single SDK provider + union firewall. */
  provider: DeviceProvider;
  /** Optional agentic-economy settlement rails advertised in this device's caps. */
  settlement?: SettlementManager;
  inflight: Inflight;
  audit: AuditLog;
  /** Locally-tombstoned peers, excluded from caps/firewall/warm-pool. */
  isForgotten?: (deviceId: string) => boolean;
  /** Pre-warm the payment-control connection when this mesh's warm pool sees a live paid provider. */
  onPaidPeer?: (providerKey: string) => void;
  /** Reputation-weighted routing ranker (HYPHA_REPUTATION). Absent → legacy inflight-first routing. */
  reputation?: ReputationRanker;
  /** Phase 4 — advertise a wallet↔provider-key `identityProof` in this device's caps (costly identity). */
  bindIdentity?: boolean;
  /** Mesh model sharing — whether peers may discover + pull this node's cached models (advisory). */
  shareModels?: () => boolean;
  /** Per-alias sharing — serve aliases NOT to advertise to the mesh. Empty/absent = advertise all. */
  unsharedAliases?: () => Set<string>;
}

/**
 * Bring one mesh online against an already-open, swarmed `graph`: advertise this device's
 * capability into it (heartbeat), contribute its paired consumers to the device-global union
 * firewall, and run the consumer warm pool. The SDK provider is the DeviceProvider's job.
 */
export async function startMeshServices(graph: MeshGraph, deps: StartMeshServicesDeps): Promise<MeshRuntime> {
  const { meshId, provider, inflight, audit, settlement } = deps;
  const isForgotten = deps.isForgotten ?? (() => false);
  const selfKey = await provider.ensureStarted();
  const aliases = localChatAliases();
  /** Live caps with locally-disconnected (tombstoned) peers removed — the single filter point. */
  const liveCaps = async (): Promise<DeviceCapability[]> => {
    const caps = (await graph.capabilities()).filter((c) => !isForgotten(c.deviceId));
    for (const c of caps) settlement?.noteCapability(c);
    return caps;
  };

  const payouts = settlement?.payoutEndpoints() ?? [];
  // Phase 4 — the wallet↔provider-key binding is STATIC (key + wallet don't change), so sign it ONCE
  // and splice it into every heartbeat cap. undefined = not computed yet; null = none (flag off / no rail).
  let identityProof: DeviceIdentityProof | null | undefined;
  const ensureIdentityProof = async (): Promise<void> => {
    if (identityProof !== undefined) return;
    identityProof = deps.bindIdentity && settlement ? await settlement.signIdentityBinding(selfKey) : null;
    if (identityProof) audit.record({ event: "capability", extra: { role: "mesh-services", meshId, phase: "identity-bound", wallet: identityProof.wallet, provider: selfKey.slice(0, 16) } });
    else if (deps.bindIdentity) audit.record({ event: "note", extra: { role: "mesh-services", meshId, phase: "identity-bind-unavailable", reason: "no Plasma rail / wallet could not sign" } });
  };
  const buildCap = (): DeviceCapability => {
    // Per-alias sharing: drop denied aliases from the advertised model list (empty deny-set = full
    // list, byte-identical to before). Read fresh each advertise so a runtime toggle takes effect.
    const denied = deps.unsharedAliases?.();
    const shown = denied && denied.size ? aliases.filter((a) => !denied.has(a.alias)) : aliases;
    return makeCapability({
      deviceId: graph.localWriterKey,
      displayName: DEVICE_NAME,
      computeClass: COMPUTE_CLASS,
      ramMB: RAM_MB,
      powerState: POWER_STATE,
      availableModels: shown.map((a) => a.alias),
      models: shown,
      inflight: inflight.get(),
      consumerPublicKey: selfKey,
      isProvider: true,
      providerPublicKey: selfKey,
      meshId,
      roles: ["compute-provider", "compute-consumer"],
      shareModels: deps.shareModels ? deps.shareModels() : true,
      ...(payouts[0] ? { settlement: payouts[0] } : {}),
      ...(payouts.length > 0 ? { settlements: payouts } : {}),
      ...(identityProof ? { identityProof } : {}),
    });
  };

  // This mesh's contribution to the device-global firewall: its paired peers' consumer keys.
  const reconcileFirewall = async (): Promise<void> => {
    try {
      const desired = unionAllowedConsumers([await liveCaps()], selfKey, isForgotten);
      await provider.setMeshConsumers(meshId, desired);
    } catch (err) {
      audit.record({ event: "note", extra: { role: "mesh-services", meshId, phase: "firewall-contrib-failed", error: String(err) } });
    }
  };
  await reconcileFirewall();

  const advertise = async (): Promise<void> => {
    await ensureIdentityProof();
    await graph.advertise(buildCap()).catch((e) => console.error("⚠️ advertise failed:", e));
  };
  await advertise();

  const hbTimer = setInterval(() => void advertise(), HEARTBEAT_MS);
  if (typeof hbTimer.unref === "function") hbTimer.unref();
  const fwTimer = setInterval(() => void reconcileFirewall(), HEARTBEAT_MS);
  if (typeof fwTimer.unref === "function") fwTimer.unref();

  const pool = new WarmPool({ caps: liveCaps, selfKey, staleMs: STALE_MS, tickMs: WARM_TICK_MS, audit, ...(deps.onPaidPeer ? { onPaidPeer: deps.onPaidPeer } : {}), ...(deps.reputation ? { reputation: deps.reputation } : {}) });
  pool.start();

  console.log(`🧠 mesh ${meshId} online — key ${selfKey.slice(0, 16)}… · serving ${aliases.length} alias(es): ${aliases.map((a) => a.alias).join(", ") || "(none)"}`);

  return {
    meshId,
    graph,
    selfKey,
    pool,
    reconcileFirewall,
    advertise,
    stop: async () => {
      clearInterval(hbTimer);
      clearInterval(fwTimer);
      pool.stop();
      await provider.removeMesh(meshId);
    },
  };
}
