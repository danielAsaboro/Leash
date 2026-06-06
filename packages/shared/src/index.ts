/**
 * @mycelium/shared — types and helpers shared across all layers.
 *
 * Keep this layer dependency-free (no @qvac/sdk import) so every package and the
 * spike can use the types without pulling in the runtime.
 */

/** Device compute class, coarse-grained for the capability registry (Layer 1). */
export type ComputeClass = "phone" | "pi" | "mac" | "server";

/** Power state advertised by a device so the router can avoid draining batteries. */
export type PowerState = "battery" | "charging" | "plugged";

/**
 * What a device advertises to the mesh capability registry (Layer 1 / spec §Mesh).
 * The router/scheduler uses these to place work (e.g. delegate heavy reasoning to
 * the highest-RAM, plugged-in device).
 */
export interface DeviceCapability {
  /** Stable device id (e.g. the QVAC hyperswarm public key). */
  deviceId: string;
  displayName: string;
  computeClass: ComputeClass;
  /** Total physical RAM in MB. */
  ramMB: number;
  powerState: PowerState;
  /** QVAC model registry ids this device has cached and can serve. */
  availableModels: string[];
  /**
   * Serve aliases this device exposes, each paired with the delegable `modelSrc`
   * (the SDK `.src` / registryPath string) a peer hands to `loadDelegated`. Resolved
   * from `qvac.config.base.json` against the model catalog. Optional: pre-Hypha devices
   * advertise only `availableModels`. (Layer-1 / Hypha overflow.)
   */
  models?: { alias: string; modelSrc: string }[];
  /**
   * Current in-flight generations on this device (delegated + local), a live load
   * signal. The registry prefers lower-`inflight` providers so a free strong peer
   * beats a saturated one. Absent → treated as 0.
   */
  inflight?: number;
  /**
   * This device's delegated-inference CONSUMER public key, gossiped so providers can
   * allow-list it in their SDK firewall (closed-mesh trust). Distinct from
   * `providerPublicKey` (the provider identity).
   */
  consumerPublicKey?: string;
  /** True if this device exposes a delegated-inference provider (startQVACProvider). */
  isProvider: boolean;
  /** Provider public key when isProvider is true. */
  providerPublicKey?: string;
  lastSeen: string; // ISO timestamp
}

/**
 * Canonical audit-log record for the hackathon's 3-stage verification evidence
 * bundle. Emitted as JSONL (one record per line).
 *
 * NOTE: spike/lib/audit-log.ts mirrors this shape so the spike stays standalone
 * (no build step). Keep the two in sync.
 */
export interface AuditRecord {
  ts: string; // ISO timestamp
  /** Which spike / subsystem emitted this. */
  source: string;
  event:
    | "model_load"
    | "model_unload"
    | "prompt"
    | "completion"
    | "embedding"
    | "rag_ingest"
    | "rag_search"
    | "finetune_progress"
    | "finetune_result"
    | "delegation"
    | "graph_sync"
    | "pairing"
    | "capability"
    | "note";
  modelId?: string;
  modelSrc?: string;
  device?: "cpu" | "gpu";
  prompt?: string;
  /** Tokens generated (completion) or chunks (rag). */
  tokens?: number;
  /** Time to first token, ms. */
  ttftMs?: number;
  tokensPerSecond?: number;
  /** Wall-clock duration of the operation, ms. */
  durationMs?: number;
  /** Free-form structured extras (latency breakdowns, scores, loss, etc.). */
  extra?: Record<string, unknown>;
}

/**
 * Build a {@link DeviceCapability} with `lastSeen` defaulted to now. Used to seed
 * the Layer-1 capability registry from local config (mesh/registry.ts).
 */
export function makeCapability(
  cap: Omit<DeviceCapability, "lastSeen"> & { lastSeen?: string },
): DeviceCapability {
  return { ...cap, lastSeen: cap.lastSeen ?? new Date().toISOString() };
}

/** Minimal leveled logger; real layers can swap in @qvac/sdk's logger later. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(scope: string) {
  const emit = (level: LogLevel, msg: string, extra?: unknown) => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} (${scope}) ${msg}`;
    if (level === "error") console.error(line, extra ?? "");
    else if (level === "warn") console.warn(line, extra ?? "");
    else console.log(line, extra ?? "");
  };
  return {
    debug: (m: string, e?: unknown) => emit("debug", m, e),
    info: (m: string, e?: unknown) => emit("info", m, e),
    warn: (m: string, e?: unknown) => emit("warn", m, e),
    error: (m: string, e?: unknown) => emit("error", m, e),
  };
}

// Audit logger lives in its own module (filesystem-touching); re-exported here so
// every layer imports it from "@mycelium/shared".
export { AuditLog, now } from "./audit.ts";

// The context-graph node type — the unit replicated across the mesh (Week-2). Lives
// here (dependency-free) so both senses and mesh use it without a dependency cycle.
export type { GraphNode, GraphNodeInput } from "./graph.ts";
