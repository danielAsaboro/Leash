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
