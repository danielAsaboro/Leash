/**
 * Mesh services — the provider + heartbeat + firewall-reconcile + warm pool bundle that
 * runs ONCE the device is in a mesh. Extracted from the daemon so it can be started lazily:
 * at boot if a mesh store already exists, or the moment LAN pairing creates/joins one.
 *
 * A device with no mesh yet (fresh, never paired) runs only the shim + discovery; there are
 * no peers to gossip to or serve, so none of this is needed until it pairs.
 */
import { AuditLog, makeCapability } from "@mycelium/shared";
import type { DeviceCapability } from "@mycelium/shared";
import { stopQVACProvider } from "@qvac/sdk";
import { startProvider } from "@mycelium/mesh";
import type { MeshGraph } from "@mycelium/mesh";
import { WarmPool } from "./warm-pool.ts";
import { localChatAliases } from "./catalog.ts";
import type { Inflight } from "./shim.ts";
import { COMPUTE_CLASS, DEVICE_NAME, HEARTBEAT_MS, POWER_STATE, RAM_MB, STALE_MS, WARM_TICK_MS } from "./config.ts";

export interface MeshRuntime {
  graph: MeshGraph;
  selfKey: string;
  pool: WarmPool;
  /** Re-run the firewall reconcile now (e.g. immediately after forgetting a peer). */
  reconcileFirewall(): Promise<void>;
  /** Stop the graph-bound services (timers + warm pool). Leaves the SDK provider running. */
  stop(): Promise<void>;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Bring the mesh online against an already-open, swarmed `graph`: start the delegated-
 * inference provider (closed firewall, then reconciled to paired peers), a live heartbeat
 * (rebuilt each tick so inflight/models/lastSeen stay current), and the consumer warm pool.
 */
export async function startMeshServices(
  graph: MeshGraph,
  seed: string,
  inflight: Inflight,
  audit: AuditLog,
  isForgotten: (deviceId: string) => boolean = () => false,
): Promise<MeshRuntime> {
  const { publicKey: selfKey } = await startProvider({ seed, audit, allowedConsumers: [] });
  const aliases = localChatAliases();
  /** Live caps with locally-disconnected (tombstoned) peers removed — the single filter point. */
  const liveCaps = async () => (await graph.capabilities()).filter((c) => !isForgotten(c.deviceId));

  const buildCap = (): DeviceCapability =>
    makeCapability({
      deviceId: graph.localWriterKey,
      displayName: DEVICE_NAME,
      computeClass: COMPUTE_CLASS,
      ramMB: RAM_MB,
      powerState: POWER_STATE,
      availableModels: aliases.map((a) => a.alias),
      models: aliases,
      inflight: inflight.get(),
      consumerPublicKey: selfKey,
      isProvider: true,
      providerPublicKey: selfKey,
    });

  let currentAllow = new Set<string>();
  const reconcileFirewall = async (): Promise<void> => {
    try {
      const caps = await liveCaps(); // forgotten peers are excluded → they stop being served
      const desired = new Set(
        caps.filter((c) => c.providerPublicKey !== selfKey).map((c) => c.consumerPublicKey).filter((k): k is string => Boolean(k)),
      );
      if (sameSet(desired, currentAllow)) return;
      await stopQVACProvider();
      await startProvider({ seed, audit, allowedConsumers: [...desired] });
      currentAllow = desired;
      console.log(`🔒 firewall updated — ${desired.size} allowed consumer(s)`);
    } catch (err) {
      audit.record({ event: "note", extra: { role: "provider", phase: "firewall-reconcile-failed", error: String(err) } });
      console.error("⚠️ firewall reconcile failed:", err);
    }
  };
  await reconcileFirewall();

  await graph.advertise(buildCap()).catch((e) => console.error("⚠️ advertise failed:", e));
  const hbTimer = setInterval(() => void graph.advertise(buildCap()).catch(() => undefined), HEARTBEAT_MS);
  if (typeof hbTimer.unref === "function") hbTimer.unref();
  const fwTimer = setInterval(() => void reconcileFirewall(), HEARTBEAT_MS);
  if (typeof fwTimer.unref === "function") fwTimer.unref();

  const pool = new WarmPool({ caps: liveCaps, selfKey, staleMs: STALE_MS, tickMs: WARM_TICK_MS, audit });
  pool.start();

  console.log(`🧠 mesh online — key ${selfKey.slice(0, 16)}… · serving ${aliases.length} alias(es): ${aliases.map((a) => a.alias).join(", ") || "(none)"}`);

  return {
    graph,
    selfKey,
    pool,
    reconcileFirewall,
    stop: async () => {
      clearInterval(hbTimer);
      clearInterval(fwTimer);
      pool.stop();
    },
  };
}
