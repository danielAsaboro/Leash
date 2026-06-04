/**
 * The private context graph for `search_graph` — a tiny in-memory RAG index built
 * over the user's notes, embedded through the QVAC embeddings endpoint (HTTP).
 *
 * Keeping retrieval HTTP-only (via the AI SDK `embed`/`embedMany` against `qvac serve`)
 * means the Next route stays a pure client — no native `@qvac/sdk` in the web process.
 * The index is built lazily once per process and cached. At this scale (a handful of
 * notes) an in-memory cosine search is plenty; a larger graph would swap in a real
 * vector store behind this same `searchNotes` interface.
 */
import "server-only";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, embedMany } from "ai";
import { embeddingModel } from "./provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data/notes. */
const NOTES_DIR = process.env["LEASH_NOTES_DIR"] ?? join(here, "..", "..", "..", "..", "data", "notes");

interface Chunk {
  source: string;
  text: string;
  embedding: number[];
}

let indexPromise: Promise<Chunk[]> | null = null;

/** Split a note into paragraph-ish chunks, dropping trivially short fragments. */
function chunkText(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40);
}

async function buildIndex(): Promise<Chunk[]> {
  if (!existsSync(NOTES_DIR)) return [];
  const docs: { source: string; text: string }[] = [];
  for (const f of readdirSync(NOTES_DIR).filter((n) => n.endsWith(".md"))) {
    for (const c of chunkText(readFileSync(join(NOTES_DIR, f), "utf-8"))) {
      docs.push({ source: basename(f), text: c });
    }
  }
  if (docs.length === 0) return [];
  const { embeddings } = await embedMany({ model: embeddingModel(), values: docs.map((d) => d.text) });
  return docs.map((d, i) => ({ ...d, embedding: embeddings[i] as number[] }));
}

function getIndex(): Promise<Chunk[]> {
  return (indexPromise ??= buildIndex());
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface GraphHit {
  source: string;
  text: string;
  score: number;
}

/** Top-K most similar note chunks for a query (cosine over QVAC embeddings). */
export async function searchNotes(query: string, topK = 3): Promise<GraphHit[]> {
  const index = await getIndex();
  if (index.length === 0) return [];
  const { embedding } = await embed({ model: embeddingModel(), value: query });
  return index
    .map((c) => ({ source: c.source, text: c.text, score: cosine(embedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
