/**
 * Shared types for the living-mesh visualization (`/mesh`). Mirrors the Hypha daemon's
 * `/peers` PeerView rows and the `/events` MeshEvent stream — the two real data sources the
 * graph is built from. No invented fields: every property here is emitted by the daemon.
 */

/** One peer device, as the daemon reports it on `/peers`. */
export interface PeerView {
  deviceId: string;
  displayName: string;
  /** 16-char provider-key prefix — matches `MeshEvent.peer` for activity lighting. */
  peerId?: string;
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  models: string[];
  modelInfo?: { alias: string; modelType: string; borrowable: boolean }[];
  warmModels: string[];
  live: boolean;
  warm: boolean;
  lastSeen: string;
  pricePerKiloToken?: number;
  reputationScore?: number;
  meshId?: string;
  meshLabel?: string;
}

/** A mesh membership summary (one row per mesh this device belongs to). */
export interface MeshSummary {
  meshId: string;
  label: string;
  visibility?: string;
  peers?: number;
  writable?: boolean;
  creator?: boolean;
}

/** The `/peers` response envelope. */
export interface PeersResponse {
  ok?: boolean;
  error?: string;
  peers?: PeerView[];
  self?: { providerKey?: string | null; wallet?: string | null };
  writable?: boolean | null;
  meshId?: string | null;
  meshes?: MeshSummary[];
}

/** One live routing event off the `/events` SSE — the delegation-audit mirror. */
export interface MeshEvent {
  ts: number;
  kind: "route" | "done" | "failed";
  phase: string;
  alias?: string;
  peer?: string;
  peers?: number;
  endpoint?: string;
  meshId?: string;
  tokens?: number;
  bytes?: number;
  ms?: number;
  error?: string;
}

/** Derived per-node activity status the graph renders. */
export type NodeStatus = "offline" | "idle" | "warm" | "running" | "failed";
