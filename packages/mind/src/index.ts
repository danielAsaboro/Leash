/**
 * Layer 3 — Mind: distributed reasoning (Pillar 2). STUB: interfaces only.
 *
 * Router: trivial queries → single small model on the phone; hard queries →
 * convene the council (2–4 small models with distinct roles, debating with
 * tool-calling over the context graph, RAG-grounded + cited). Heavy reasoning is
 * delegated phone→Mac over encrypted P2P — primitive (c) in the spike (spec §Mind).
 */
import type { DeviceCapability } from "@mycelium/shared";

/** Distinct council roles per the spec (proposer / critic / specialist / verifier). */
export type CouncilRole = "proposer" | "critic" | "specialist" | "verifier";

export interface CouncilMember {
  role: CouncilRole;
  /** QVAC model registry id this member runs. */
  modelSrc: string;
  /** Device this member is placed on (may be a delegated provider). */
  device: DeviceCapability;
}

/** Decides whether a query is trivial (single model) or hard (convene council). */
export interface QueryRouter {
  isHard(query: string): Promise<boolean>;
}

/** A cited, RAG-grounded answer with the council's reasoning trace. */
export interface CouncilAnswer {
  answer: string;
  citations: string[]; // context-graph node ids
  trace: Array<{ role: CouncilRole; content: string }>;
}

export interface Council {
  members: CouncilMember[];
  /** Run the debate over the RAG-grounded context and return a cited answer. */
  deliberate(query: string): Promise<CouncilAnswer>;
}

export const LAYER = "mind" as const;
