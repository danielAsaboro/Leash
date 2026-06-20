/**
 * Routing types — the shared vocabulary for the Conductor router. One source of truth
 * imported by the MCP discovery group (leash-tools-mcp daemon) AND the web chat route.
 */
export type Modality = "text" | "vision" | "audio" | "ocr";
export type ParamClass = "tiny" | "small" | "mid" | "large" | "unknown";
export type Specialist = "general" | "health" | "vision" | "ocr" | "computer";
/** Matches apps/hypha mesh-router: "private" = keep in-mesh (sensitive); "shareable" = public OK. */
export type Sensitivity = "private" | "shareable";
/** "public" is the documented extension seam — the sensitivity gate excludes it; not built this round. */
export type Tier = "device" | "private" | "public";

export interface CapabilityTags {
  modality: Modality;
  paramClass: ParamClass;
  specialist: Specialist;
  contextWindow?: number;
}

/** What a turn REQUIRES. A route clears the bar when its tags satisfy every field. */
export interface CapabilityBar {
  modality: Modality;
  /** Route paramClass must be >= this (unknown is treated as below tiny). */
  minParamClass: Exclude<ParamClass, "unknown">;
  /** When set and not "general", the route's specialist must equal it. */
  specialist?: Specialist;
}

/** A reachable place a turn could run, with execution coordinates + cost/load signals. */
export interface RouteOption {
  tier: Tier;
  alias: string;
  tags: CapabilityTags;
  /** undefined ⇒ this device (local). Set ⇒ delegate to this mesh peer. */
  peerKey?: string;
  /** Mesh the peer belongs to (the shared-autobase id the shim expects as `meshId`). */
  meshId?: string;
  /** Delegable SDK src for a peer route (DeviceCapability.models[].modelSrc). */
  modelSrc?: string;
  /** µ per kilo-token. 0 for local. */
  pricePerKiloToken: number;
  /** Live in-flight generations on the host. */
  inflight: number;
  latencyHint?: number;
}

export interface RankedRoute extends RouteOption {
  score: number;
  reason: string;
}
