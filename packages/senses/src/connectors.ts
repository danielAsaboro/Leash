/**
 * File connector (Layer 2 — Senses).
 *
 * Turns a directory of markdown notes into graph nodes and indexes them — the
 * "files" half of the Week-1 context graph (voice is added in voice.ts). Used by
 * the hub (its canonical graph) and the edge (its local replica). The workspace is
 * reset first so each ingest is deterministic.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { ragDeleteWorkspace } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import { GraphStore } from "./graph-store.ts";
import { ingestNodes } from "./rag-index.ts";

export interface IngestNotesDirParams {
  notesDir: string;
  /** JSONL path for the graph node store (reset each call). */
  graphFile: string;
  embModelId: string;
  workspace: string;
  audit?: AuditLog;
}

/** Read every `.md` in notesDir into a fresh GraphStore, then index into the workspace. */
export async function ingestNotesDir({ notesDir, graphFile, embModelId, workspace, audit }: IngestNotesDirParams): Promise<{ nodes: number; chunks: number }> {
  // Deterministic: clear the prior node log and vector workspace.
  rmSync(graphFile, { force: true });
  try {
    await ragDeleteWorkspace({ workspace });
  } catch {
    /* workspace may not exist yet */
  }

  const store = new GraphStore(graphFile);
  for (const f of readdirSync(notesDir).filter((n) => n.endsWith(".md"))) {
    store.append({ kind: "file", source: join("data/notes", basename(f)), text: readFileSync(join(notesDir, f), "utf-8").trim() });
  }
  const nodes = store.all();
  const chunks = await ingestNodes({ embModelId, workspace, nodes, audit });
  return { nodes: nodes.length, chunks };
}
