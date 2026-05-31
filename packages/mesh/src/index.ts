/**
 * Layer 1 — Mesh fabric (foundation). STUB: interfaces only.
 *
 * QVAC native P2P (Holepunch/Hyperswarm) auto-connects all devices, zero-config,
 * encrypted. A capability registry has each device advertise RAM / models /
 * compute class / power state; a router/scheduler uses it to place work.
 *
 * Built only after the spike gate is GO (delegated compute = primitive (c)).
 */
import type { DeviceCapability } from "@mycelium/shared";

/** Tracks which devices are in the mesh and what they can do (spec §Mesh). */
export interface CapabilityRegistry {
  /** Advertise this device's capabilities to the mesh. */
  announce(self: DeviceCapability): Promise<void>;
  /** All currently-known devices. */
  list(): Promise<DeviceCapability[]>;
  /** Subscribe to join/leave/update events. */
  onChange(handler: (devices: DeviceCapability[]) => void): () => void;
}

/** A unit of work the router can place on some device in the mesh. */
export interface WorkRequest {
  kind: "completion" | "embedding" | "finetune";
  /** Minimum RAM (MB) a device needs to accept this work. */
  minRamMB?: number;
  /** Preferred model registry id. */
  modelSrc?: string;
}

/** Places work on the best device per the registry (spec §Mesh router/scheduler). */
export interface Router {
  /** Pick a device to run the given work, or null if none qualifies. */
  place(req: WorkRequest): Promise<DeviceCapability | null>;
}

export const LAYER = "mesh" as const;
