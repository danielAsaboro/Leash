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

// ── Multi-mesh membership ───────────────────────────────────────────────────────────
// Spec: docs/superpowers/specs/2026-06-08-multi-mesh-membership-design.md §1. A device
// belongs to MANY meshes at once; the atom of belonging is a Membership, not a device.
// Two independent axes describe a mesh; a Set of roles describes how THIS device
// participates in it. (Phase-1 wires only the fields it uses; the rest are spec'd ahead.)

/** Axis 1a — a closed group of trusted devices, or an open public cell? */
export type Visibility = "private" | "public";
/** Axis 1b — discovered on the local network only, or across the wide DHT? */
export type Reach = "local" | "wide";
/**
 * Axis 2 — how this device participates in ONE mesh (a Set: a device can hold several
 * roles in the same mesh). `compute-provider` serves delegated inference; `compute-consumer`
 * borrows it; `publisher` writes the shared log; `subscriber` replicates read-only; `relay`
 * forwards for others (QVAC blind-relays).
 */
export type Role = "compute-provider" | "compute-consumer" | "publisher" | "subscriber" | "relay";

/**
 * A mesh the device can belong to. `id` is random for a private mesh (a stable handle for
 * the Autobase) and a geocell hash for a public cell (Phase 3). `tier` is the
 * delegation-ladder rank — LOWER is tried first (the private/local home mesh is tier 0); its
 * default derives from `type`, but it is explicit so same-type meshes can be ordered
 * (primary vs secondary). See spec §6.
 */
export interface Mesh {
  id: string;
  label: string;
  type: { visibility: Visibility; reach: Reach };
  tier: number;
}

/**
 * THIS device's membership in one {@link Mesh}. `roles` is what it does there; `toolGrant`
 * is the tools dispatchable in this mesh (public → `[]` or a curated safe set);
 * `contextMount` is the RAG index id mounted for it (public → null); `allowedDevices` is the
 * pairing allow-list (private → permitted writer keys; public → undefined = open join). The
 * `Set`/in-memory fields live in device config, never on the wire (caps serialize as JSON).
 */
export interface Membership {
  mesh: Mesh;
  roles: Set<Role>;
  toolGrant: string[];
  contextMount: string | null;
  allowedDevices?: Set<string>;
}

/**
 * Privacy class carried by a delegation request — the eligibility input to the delegation
 * ladder (spec §6.3). `private` may never leave its current mesh tier; `shareable` may fall
 * through to wider/public tiers. Default is `private` (fail-closed): you opt IN to going wider.
 */
export type Sensitivity = "private" | "shareable";

/** One payout rail a device can advertise for machine-economy settlement. */
export interface SettlementEndpoint {
  /** Chain/network family this endpoint expects. */
  network: "plasma" | "solana";
  /** Optional protocol/network id for standards integrations (e.g. x402 network id). */
  networkId?: string;
  /** Human-readable asset symbol (e.g. USDT). */
  asset: string;
  /** Asset identifier on the network: SPL mint on Solana, token contract on Plasma/EVM. */
  mint: string;
  /** Token decimals for the mint (stablecoins are usually 6 on Solana). */
  decimals: number;
  /** Wallet public key / address that should receive settlement. */
  recipient: string;
  /**
   * Optional x402 metadata for this rail. When present, the consumer can pre-authorize a real
   * compute budget (typically `scheme:"upto"`) BEFORE delegated compute starts, then settle a
   * smaller actual amount after the run completes.
   */
  x402?: {
    version: 2;
    scheme: "upto";
    facilitator: string;
    maxTimeoutSeconds: number;
    pricePerKiloToken: number;
  };
}

/** One provider-signed receipt for a paid delegated-compute session. */
export interface SessionSettlementReceipt {
  sessionId: string;
  meshId: string;
  alias: string;
  modelSrc: string;
  budgetCap: number;
  actualTokens: number;
  actualAmount: number;
  network: "plasma" | "solana";
  networkId?: string;
  asset: string;
  txHash: string;
  openedAt: string;
  completedAt: string;
  settledAt: string | null;
  status: "settled" | "retrying" | "closed";
  payerId: string;
  payerAddress: string;
  providerId: string;
  providerAddress: string;
  consumerWriterKey: string;
  consumerPublicKey: string;
  providerWriterKey: string;
  providerPublicKey: string;
  payTo: string;
  nonce: string;
  x402Version: 2;
  scheme: "upto";
  providerSignature: string;
  failureReason?: string;
  retryCount?: number;
}

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
  /**
   * Which mesh this capability was advertised into (a {@link Mesh} id). Lets a device that
   * holds several memberships scope caps per mesh, and gives the union-firewall reconcile
   * (spec §4) its provenance. Absent on pre-multi-mesh caps → treated as the primary mesh.
   */
  meshId?: string;
  /**
   * This device's role(s) in `meshId` (spec §1 Axis 2). Array (not Set) because caps go on
   * the wire as JSON. Absent → the pre-multi-mesh default (provider + consumer), as today.
   */
  roles?: Role[];
  /** Optional machine-economy payout rail this device accepts for delegated compute. */
  settlement?: SettlementEndpoint;
  /** Multi-rail version of `settlement` (e.g. Plasma first, Solana fallback). */
  settlements?: SettlementEndpoint[];
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
    // Layer 4 — Memory ("The Understory"): the curate→train→eval→apply→share loop.
    | "curate"
    | "eval"
    | "adapter_publish"
    | "adapter_fetch"
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
  /** Prompt tokens served from a KV-cache hit (delegated kvCache sessions). */
  cacheTokens?: number;
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

// KV-cache session ledger (hypha shim + Leash web chat route share the proven logic).
export { KvSessions, sweepKvCacheDir } from "./kv-sessions.ts";
export type { ChatTurn, KvResolution } from "./kv-sessions.ts";

// The context-graph node type — the unit replicated across the mesh (Week-2). Lives
// here (dependency-free) so both senses and mesh use it without a dependency cycle.
export type { GraphNode, GraphNodeInput } from "./graph.ts";
