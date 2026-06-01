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
import type { GraphNode, GraphNodeInput } from "@mycelium/shared";

// The node type moved to @mycelium/shared in Week-2 (so mesh can replicate it
// without a senses↔mesh cycle); re-exported here for back-compat with every
// `import { GraphNode } from "@mycelium/senses"` call site.
export type { GraphNode, GraphNodeInput } from "@mycelium/shared";

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
