/**
 * Layer 2 — Senses: the context graph (Pillar 3). STUB: interfaces only.
 *
 * Hypercore/Autobase append-only logs + CRDTs form an encrypted, replicated
 * personal knowledge graph synced P2P across devices. On-device embeddings →
 * vector RAG index over the graph (spec §Senses). RAG is primitive (b) in the spike.
 */
import type { AuditRecord } from "@mycelium/shared";

/** A signal captured from a sensor/connector and folded into the context graph. */
export interface ContextNode {
  id: string;
  /** Where it came from: a file, voice note (STT), photo (OCR/vision), etc. */
  source: "file" | "voice" | "photo" | "calendar" | "location" | "ambient";
  text: string;
  createdAt: string; // ISO
  /** Optional path to the original media for multimodal completion attachments. */
  mediaPath?: string;
}

/** MVP connectors per spec: files, voice (STT), photos (OCR/vision). */
export interface Connector {
  source: ContextNode["source"];
  /** Pull new signals since the last sync. */
  poll(): Promise<ContextNode[]>;
}

/** The encrypted, P2P-replicated personal knowledge graph + its RAG index. */
export interface ContextGraph {
  ingest(nodes: ContextNode[]): Promise<void>;
  /** RAG-grounded retrieval over the graph; returns cited nodes. */
  retrieve(query: string, topK: number): Promise<Array<{ node: ContextNode; score: number }>>;
  /** Audit trail of what was sensed/retrieved (evidence bundle). */
  audit(): AsyncIterable<AuditRecord>;
}

export const LAYER = "senses" as const;
