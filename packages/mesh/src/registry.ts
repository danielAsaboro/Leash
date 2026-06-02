/**
 * Capability registry (Layer 1 — Mesh).
 *
 * In-memory map of what each device advertises (RAM, models, compute class, power
 * state, provider pubkey). The router uses `bestProvider()` to place heavy work on
 * the strongest plugged-in provider. For the Week-1 slice it's seeded from local
 * config + the hub's printed pubkey; P2P gossip of capabilities is Week-2 Mesh-depth.
 */
import type { DeviceCapability, PowerState } from "@mycelium/shared";

const POWER_RANK: Record<PowerState, number> = { plugged: 2, charging: 1, battery: 0 };

export class CapabilityRegistry {
  private readonly devices = new Map<string, DeviceCapability>();

  /** Add or replace a device's advertised capability. */
  register(cap: DeviceCapability): DeviceCapability {
    this.devices.set(cap.deviceId, cap);
    return cap;
  }

  /** Every known device, in registration order. */
  list(): DeviceCapability[] {
    return [...this.devices.values()];
  }

  /** Look up one device by id. */
  get(deviceId: string): DeviceCapability | undefined {
    return this.devices.get(deviceId);
  }

  /** All advertised providers, best-first (plugged/charging, then highest RAM). */
  rankedProviders(): DeviceCapability[] {
    return this.list()
      .filter((d) => d.isProvider && d.providerPublicKey)
      .sort((a, b) => POWER_RANK[b.powerState] - POWER_RANK[a.powerState] || b.ramMB - a.ramMB);
  }

  /**
   * The best provider to delegate heavy work to: an advertised provider, preferring
   * plugged-in/charging devices, then highest RAM. Returns undefined if none.
   */
  bestProvider(): DeviceCapability | undefined {
    return this.rankedProviders()[0];
  }
}
