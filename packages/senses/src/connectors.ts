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
import type { AuditLog, GraphNode, GraphNodeInput } from "@mycelium/shared";
import { GraphStore } from "./graph-store.ts";
import { ingestNodes } from "./rag-index.ts";
import { transcribeFile, diarizeFile } from "./voice.ts";
import { ocrFile } from "./photo.ts";

const PHOTO_RE = /\.(png|jpg|jpeg)$/i;

/**
 * Turn one voice file into a `kind:"voice"` node payload. If a Parakeet diarizer +
 * transcriber pair is supplied, the transcript is speaker-attributed and the segments
 * land in `meta` (quote attribution); otherwise it's a flat Whisper transcript. Returns
 * null for empty audio.
 */
async function voiceNode(
  audioPath: string,
  ids: { sttModelId?: string; diarizerModelId?: string; transcriberModelId?: string },
  audit?: AuditLog,
): Promise<{ text: string; meta: Record<string, unknown> } | null> {
  if (ids.diarizerModelId && ids.transcriberModelId) {
    const { text, segments, speakers } = await diarizeFile({ diarizerModelId: ids.diarizerModelId, transcriberModelId: ids.transcriberModelId, audioPath, audit });
    return text ? { text, meta: { diarized: true, speakers, segments } } : null;
  }
  if (ids.sttModelId) {
    const text = await transcribeFile({ sttModelId: ids.sttModelId, audioPath, audit });
    return text ? { text, meta: { transcribed: true } } : null;
  }
  return null;
}

export interface IngestNotesDirParams {
  notesDir: string;
  /** JSONL path for the graph node store (reset each call). */
  graphFile: string;
  embModelId: string;
  workspace: string;
  /** Optional: also transcribe `.wav` files in this dir into `kind:"voice"` nodes. */
  voiceDir?: string;
  /** Required if `voiceDir` is set (and no diarizer pair): a loaded whisper modelId. */
  sttModelId?: string;
  /** Optional Parakeet diarizer modelId — when paired with `transcriberModelId`, voice
   * nodes become speaker-attributed (segments in `meta`) instead of flat Whisper text. */
  diarizerModelId?: string;
  /** Required with `diarizerModelId`: a loaded Parakeet TDT transcriber modelId. */
  transcriberModelId?: string;
  /** Optional: also OCR `.png/.jpg` files in this dir into `kind:"photo"` nodes. */
  photoDir?: string;
  /** Required if `photoDir` is set: a loaded OCR modelId. */
  ocrModelId?: string;
  audit?: AuditLog;
}

/**
 * Build the context graph from a notes dir (and optionally a voice dir) into a
 * fresh GraphStore, then index everything into the workspace. Files become
 * `kind:"file"` nodes; transcribed `.wav`s become `kind:"voice"` nodes.
 */
export async function ingestNotesDir({ notesDir, graphFile, embModelId, workspace, voiceDir, sttModelId, diarizerModelId, transcriberModelId, photoDir, ocrModelId, audit }: IngestNotesDirParams): Promise<{ nodes: number; chunks: number; voiceNodes: number; photoNodes: number }> {
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
  if (voiceDir && (sttModelId || (diarizerModelId && transcriberModelId)) && existsSync(voiceDir)) {
    for (const f of readdirSync(voiceDir).filter((n) => n.endsWith(".wav"))) {
      const node = await voiceNode(join(voiceDir, f), { sttModelId, diarizerModelId, transcriberModelId }, audit);
      if (!node) continue;
      store.append({ kind: "voice", source: join("data/voice", basename(f)), text: node.text, meta: node.meta });
      voiceNodes++;
    }
  }

  let photoNodes = 0;
  if (photoDir && ocrModelId && existsSync(photoDir)) {
    for (const f of readdirSync(photoDir).filter((n) => PHOTO_RE.test(n))) {
      const text = await ocrFile({ ocrModelId, imagePath: join(photoDir, f), audit });
      if (!text) continue;
      store.append({ kind: "photo", source: join("data/photos", basename(f)), text, meta: { ocr: true } });
      photoNodes++;
    }
  }

  const nodes = store.all();
  const chunks = await ingestNodes({ embModelId, workspace, nodes, audit });
  return { nodes: nodes.length, chunks, voiceNodes, photoNodes };
}

/** Minimal structural view of an appendable graph (a MeshGraph or GraphStore-like). */
export interface AppendableGraph {
  append(node: GraphNodeInput): Promise<GraphNode> | GraphNode;
  all(): Promise<GraphNode[]> | GraphNode[];
}

export interface SeedFromDataDirParams {
  graph: AppendableGraph;
  notesDir: string;
  voiceDir?: string;
  sttModelId?: string;
  /** Optional Parakeet diarizer modelId — paired with `transcriberModelId`, voice nodes
   * become speaker-attributed (segments in `meta`) instead of flat Whisper text. */
  diarizerModelId?: string;
  /** Required with `diarizerModelId`: a loaded Parakeet TDT transcriber modelId. */
  transcriberModelId?: string;
  /** Optional: also OCR `.png/.jpg` files in this dir into `kind:"photo"` nodes. */
  photoDir?: string;
  /** Required if `photoDir` is set: a loaded OCR modelId. */
  ocrModelId?: string;
  audit?: AuditLog;
}

/**
 * Additively seed a graph from a data dir (Week-2): append file/voice nodes whose
 * `source` is not already in the graph. Idempotent — re-running adds nothing new.
 * NO reset (no rmSync, no ragDeleteWorkspace) — the graph accretes, never destroys.
 * Replaces the destructive `ingestNotesDir` rebuild for the replicated MeshGraph.
 */
export async function seedFromDataDir({ graph, notesDir, voiceDir, sttModelId, diarizerModelId, transcriberModelId, photoDir, ocrModelId, audit }: SeedFromDataDirParams): Promise<{ added: number }> {
  const existing = new Set((await graph.all()).map((n) => n.source));
  let added = 0;
  for (const f of readdirSync(notesDir).filter((n) => n.endsWith(".md"))) {
    const source = join("data/notes", basename(f));
    if (existing.has(source)) continue;
    await graph.append({ kind: "file", source, text: readFileSync(join(notesDir, f), "utf-8").trim() });
    added++;
  }
  if (voiceDir && (sttModelId || (diarizerModelId && transcriberModelId)) && existsSync(voiceDir)) {
    for (const f of readdirSync(voiceDir).filter((n) => n.endsWith(".wav"))) {
      const source = join("data/voice", basename(f));
      if (existing.has(source)) continue;
      const node = await voiceNode(join(voiceDir, f), { sttModelId, diarizerModelId, transcriberModelId }, audit);
      if (!node) continue;
      await graph.append({ kind: "voice", source, text: node.text, meta: node.meta });
      added++;
    }
  }
  if (photoDir && ocrModelId && existsSync(photoDir)) {
    for (const f of readdirSync(photoDir).filter((n) => PHOTO_RE.test(n))) {
      const source = join("data/photos", basename(f));
      if (existing.has(source)) continue;
      const text = await ocrFile({ ocrModelId, imagePath: join(photoDir, f), audit });
      if (!text) continue;
      await graph.append({ kind: "photo", source, text, meta: { ocr: true } });
      added++;
    }
  }
  return { added };
}
