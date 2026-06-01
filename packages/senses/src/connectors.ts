/**
 * File connector (Layer 2 — Senses).
 *
 * Turns a directory of markdown notes into graph nodes and indexes them — the
 * "files" half of the Week-1 context graph (voice is added in voice.ts). Used by
 * the hub (its canonical graph) and the edge (its local replica). The workspace is
 * reset first so each ingest is deterministic.
 */
import { readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { ragDeleteWorkspace } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import { GraphStore } from "./graph-store.ts";
import { ingestNodes } from "./rag-index.ts";
import { transcribeFile } from "./voice.ts";

export interface IngestNotesDirParams {
  notesDir: string;
  /** JSONL path for the graph node store (reset each call). */
  graphFile: string;
  embModelId: string;
  workspace: string;
  /** Optional: also transcribe `.wav` files in this dir into `kind:"voice"` nodes. */
  voiceDir?: string;
  /** Required if `voiceDir` is set: a loaded whisper modelId. */
  sttModelId?: string;
  audit?: AuditLog;
}

/**
 * Build the context graph from a notes dir (and optionally a voice dir) into a
 * fresh GraphStore, then index everything into the workspace. Files become
 * `kind:"file"` nodes; transcribed `.wav`s become `kind:"voice"` nodes.
 */
export async function ingestNotesDir({ notesDir, graphFile, embModelId, workspace, voiceDir, sttModelId, audit }: IngestNotesDirParams): Promise<{ nodes: number; chunks: number; voiceNodes: number }> {
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

  let voiceNodes = 0;
  if (voiceDir && sttModelId && existsSync(voiceDir)) {
    for (const f of readdirSync(voiceDir).filter((n) => n.endsWith(".wav"))) {
      const text = await transcribeFile({ sttModelId, audioPath: join(voiceDir, f), audit });
      if (!text) continue;
      store.append({ kind: "voice", source: join("data/voice", basename(f)), text, meta: { transcribed: true } });
      voiceNodes++;
    }
  }

  const nodes = store.all();
  const chunks = await ingestNodes({ embModelId, workspace, nodes, audit });
  return { nodes: nodes.length, chunks, voiceNodes };
}
