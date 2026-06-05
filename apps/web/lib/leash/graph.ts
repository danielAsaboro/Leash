/**
 * The private context graph for `search_graph` — a tiny in-memory RAG index built
 * over the user's notes AND the screen-watcher's activity trail, embedded through the
 * QVAC embeddings endpoint (HTTP).
 *
 * Keeping retrieval HTTP-only (via the AI SDK `embed`/`embedMany` against `qvac serve`)
 * means the Next route stays a pure client — no native `@qvac/sdk` in the web process.
 * The notes index is built lazily once per process and cached (notes are static). The
 * activity index is rebuilt whenever `leash-activity.jsonl` changes (mtime-tracked) so a
 * running `npm run watch` makes new activity semantically searchable without a restart.
 * At this scale (a handful of notes + a rolling activity log) an in-memory cosine search
 * is plenty; a larger graph would swap in a real vector store behind `searchNotes`.
 */
import "server-only";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, embedMany } from "ai";
import { embeddingModel } from "./provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data/notes. */
const NOTES_DIR = process.env["LEASH_NOTES_DIR"] ?? join(here, "..", "..", "..", "..", "data", "notes");
/** apps/web/lib/leash → repo root → data/leash-activity.jsonl (written by `npm run watch`). */
export const ACTIVITY_LOG = process.env["LEASH_ACTIVITY_LOG"] ?? join(here, "..", "..", "..", "..", "data", "leash-activity.jsonl");

interface Chunk {
  source: string;
  text: string;
  embedding: number[];
}

/** One screen-watcher activity record (mirrors apps/leash-watch store.ts). */
interface ActivityRecord {
  ts: string;
  app: string;
  window: string;
  summary: string;
  tags: string[];
}

let indexPromise: Promise<Chunk[]> | null = null;
/** Activity index cache, keyed by the JSONL mtime so it refreshes when the watcher writes. */
let activityCache: { mtimeMs: number; chunks: Chunk[] } | null = null;

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

/** Lenient per-line JSONL read of the activity trail (`[]` on missing/garbled file). */
function readActivityRecords(): ActivityRecord[] {
  let raw: string;
  try {
    raw = readFileSync(ACTIVITY_LOG, "utf-8");
  } catch {
    return [];
  }
  const out: ActivityRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as ActivityRecord);
    } catch {
      /* skip a torn/partial line */
    }
  }
  return out;
}

/** Build (embed) one chunk per activity record: "<app> — <window>: <summary> [tags]". */
async function buildActivityIndex(): Promise<Chunk[]> {
  const records = readActivityRecords();
  if (records.length === 0) return [];
  const docs = records.map((r) => {
    const d = new Date(r.ts);
    const hhmm = Number.isNaN(d.getTime())
      ? ""
      : ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const window = r.window ? ` — ${r.window}` : "";
    const tags = Array.isArray(r.tags) && r.tags.length ? ` [${r.tags.join(", ")}]` : "";
    return { source: `activity · ${r.app}${hhmm}`, text: `${r.app}${window}: ${r.summary}${tags}` };
  });
  const { embeddings } = await embedMany({ model: embeddingModel(), values: docs.map((d) => d.text) });
  return docs.map((d, i) => ({ ...d, embedding: embeddings[i] as number[] }));
}

/** The activity index, rebuilt whenever the JSONL's mtime changes (else served from cache). */
async function getActivityIndex(): Promise<Chunk[]> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(ACTIVITY_LOG).mtimeMs;
  } catch {
    activityCache = { mtimeMs: 0, chunks: [] }; // no file yet
    return [];
  }
  if (activityCache && activityCache.mtimeMs === mtimeMs) return activityCache.chunks;
  const chunks = await buildActivityIndex();
  activityCache = { mtimeMs, chunks };
  return chunks;
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

/** Top-K most similar chunks for a query — notes + screen-watcher activity, cosine over QVAC embeddings. */
export async function searchNotes(query: string, topK = 3): Promise<GraphHit[]> {
  const [notes, activity] = await Promise.all([getIndex(), getActivityIndex()]);
  const index = [...notes, ...activity];
  if (index.length === 0) return [];
  const { embedding } = await embed({ model: embeddingModel(), value: query });
  return index
    .map((c) => ({ source: c.source, text: c.text, score: cosine(embedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
