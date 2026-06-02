/**
 * Failover selection + provider heartbeat (Layer 1 — Mesh).
 *
 * A provider re-advertises its capability on a timer (refreshing `lastSeen`) so peers
 * can tell live providers from dead ones. `liveProviders` filters the replicated
 * registry to providers seen within a staleness window and orders them best-first
 * (reusing CapabilityRegistry's ranking). The edge router walks this ordered list with
 * a short per-provider timeout, ending in a local fallback.
 *
 * Append-log growth is bounded for the demo: the LWW `cap:<deviceId>` view key holds
 * exactly one entry per device regardless of heartbeat count (only the input log grows).
 */
import type { DeviceCapability } from "@mycelium/shared";
import { CapabilityRegistry } from "./registry.ts";

export interface LiveProviderOpts {
  /** Max age of a capability's lastSeen to count as live. Default 30s. */
  staleMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Default Date.now(). */
  now?: number;
}

/** Replicated caps → providers seen within staleMs, ordered best-first. */
export function liveProviders(caps: DeviceCapability[], opts: LiveProviderOpts = {}): DeviceCapability[] {
  const staleMs = opts.staleMs ?? 30_000;
  const now = opts.now ?? Date.now();
  const reg = new CapabilityRegistry();
  for (const c of caps) {
    const age = now - Date.parse(c.lastSeen);
    if (Number.isFinite(age) && age <= staleMs) reg.register(c);
  }
  return reg.rankedProviders();
}

export interface HeartbeatHandle { stop(): void; }

/** Re-advertise `cap` (with a fresh lastSeen) every intervalMs. Returns a stop handle. */
export function startHeartbeat(
  graph: { advertise(cap: DeviceCapability): Promise<void> },
  cap: Omit<DeviceCapability, "lastSeen">,
  intervalMs = 10_000,
): HeartbeatHandle {
  const beat = () => { void graph.advertise({ ...cap, lastSeen: new Date().toISOString() }); };
  beat();
  const timer = setInterval(beat, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
