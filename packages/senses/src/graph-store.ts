/**
 * The context graph's node store (Layer 2 — Senses).
 *
 * Local-first by design for the Week-1 slice: an append-only JSONL log of graph
 * nodes (same durable append pattern as the audit log). Hypercore/Autobase CRDT
 * P2P sync across the mesh is the Week-2 Mesh-depth task — this store is the seam
 * it will replace, so the node shape is already mesh-friendly (stable ids, ISO
 * timestamps, a `source` provenance field).
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** A single perception in the context graph. */
export interface GraphNode {
  /** Stable id (uuid). */
  id: string;
  /** What kind of signal produced this node. */
  kind: "file" | "voice" | "note";
  /** Provenance — file path, audio path, or a free-form origin label. */
  source: string;
  /** The text content that gets embedded + retrieved. */
  text: string;
  /** ISO timestamp the node entered the graph. */
  ts: string;
  /** Free-form structured extras (tags, device, lat/long, …). */
  meta?: Record<string, unknown>;
}

/** Fields a caller supplies; `id` and `ts` are filled in if omitted. */
export type GraphNodeInput = Omit<GraphNode, "id" | "ts"> & { id?: string; ts?: string };

export class GraphStore {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Append one node (filling id/ts if absent) and return the stored node. */
  append(node: GraphNodeInput): GraphNode {
    const full: GraphNode = {
      id: node.id ?? randomUUID(),
      ts: node.ts ?? new Date().toISOString(),
      kind: node.kind,
      source: node.source,
      text: node.text,
      ...(node.meta ? { meta: node.meta } : {}),
    };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }

  /** Read every node back, in insertion order. */
  all(): GraphNode[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as GraphNode);
  }

  get path(): string {
    return this.file;
  }
}
