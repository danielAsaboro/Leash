/**
 * The private context graph for `search_graph` — a tiny in-memory RAG index built
 * over the user's notes AND the screen-watcher's activity trail, embedded through the
 * QVAC embeddings endpoint (HTTP).
 *
 * Keeping retrieval HTTP-only (via the AI SDK `embed`/`embedMany` against `qvac serve`)
 * means the Next route stays a pure client — no native `@qvac/sdk` in the web process.
 * Both indexes are cache-invalidated by cheap filesystem fingerprints, so the dashboard's
 * memory operations are live without a restart:
 *   · notes — keyed on a directory fingerprint (file count + newest mtime), so adding,
 *     editing, or DELETING a note (Brain → Memory "forget") re-embeds on the next search
 *   · activity — keyed on (jsonl mtime, tombstones mtime); the watcher appending OR a
 *     record being tombstoned both refresh it. Tombstoned records are filtered out
 *     everywhere (see tombstones.ts — the JSONL itself is never rewritten).
 * At this scale (a handful of notes + a rolling activity log) an in-memory cosine search
 * is plenty; a larger graph would swap in a real vector store behind `searchNotes`.
 */
import "server-only";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, embedMany } from "ai";
import { embeddingModel } from "./provider.ts";
import { tombstonedSet, tombstonesMtime } from "./tombstones.ts";
import { loadMemories, MEMORIES_FILE } from "./memories-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data/notes. */
export const NOTES_DIR = process.env["LEASH_NOTES_DIR"] ?? join(here, "..", "..", "..", "..", "data", "notes");
/** apps/web/lib/leash → repo root → data/leash-activity.jsonl (written by `npm run watch`). */
export const ACTIVITY_LOG = process.env["LEASH_ACTIVITY_LOG"] ?? join(here, "..", "..", "..", "..", "data", "leash-activity.jsonl");

interface Chunk {
  source: string;
  text: string;
  embedding: number[];
}

/** One screen-watcher activity record (mirrors apps/leash-watch store.ts). */
export interface ActivityRecord {
  ts: string;
  app: string;
  window: string;
  summary: string;
  tags: string[];
}

/** Notes index cache, keyed by a directory fingerprint (count + newest mtime). */
let notesCache: { fingerprint: string; chunks: Chunk[] } | null = null;
/** Activity index cache, keyed by (jsonl mtime, tombstones mtime). */
let activityCache: { key: string; chunks: Chunk[] } | null = null;
/** Typed-memories index cache, keyed by the store file's mtime. */
let memoriesCache: { mtimeMs: number; chunks: Chunk[] } | null = null;

/** Split a note into paragraph-ish chunks, dropping trivially short fragments. */
export function chunkText(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40);
}

/** The note files (.md) currently on disk. */
function noteFiles(): string[] {
  if (!existsSync(NOTES_DIR)) return [];
  return readdirSync(NOTES_DIR).filter((n) => n.endsWith(".md")).sort();
}

/** Cheap change detector for the notes dir: file count + newest mtime. */
function notesFingerprint(files: string[]): string {
  let maxMtime = 0;
  for (const f of files) {
    try {
      maxMtime = Math.max(maxMtime, statSync(join(NOTES_DIR, f)).mtimeMs);
    } catch {
      /* raced a delete — the count still changes the fingerprint next round */
    }
  }
  return `${files.length}:${maxMtime}`;
}

async function buildIndex(files: string[]): Promise<Chunk[]> {
  const docs: { source: string; text: string }[] = [];
  for (const f of files) {
    for (const c of chunkText(readFileSync(join(NOTES_DIR, f), "utf-8"))) {
      docs.push({ source: basename(f), text: c });
    }
  }
  if (docs.length === 0) return [];
  const { embeddings } = await embedMany({ model: embeddingModel(), values: docs.map((d) => d.text) });
  return docs.map((d, i) => ({ ...d, embedding: embeddings[i] as number[] }));
}

/** The notes index, rebuilt whenever the directory fingerprint changes. */
async function getIndex(): Promise<Chunk[]> {
  const files = noteFiles();
  const fingerprint = notesFingerprint(files);
  if (notesCache && notesCache.fingerprint === fingerprint) return notesCache.chunks;
  const chunks = await buildIndex(files);
  notesCache = { fingerprint, chunks };
  return chunks;
}

/**
 * Lenient per-line JSONL read of the activity trail (`[]` on missing/garbled file),
 * with tombstoned records filtered out — every consumer sees the post-forget view.
 */
export async function readActivityRecords(): Promise<ActivityRecord[]> {
  let raw: string;
  try {
    raw = readFileSync(ACTIVITY_LOG, "utf-8");
  } catch {
    return [];
  }
  const dead = await tombstonedSet();
  const out: ActivityRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s) as ActivityRecord;
      if (!dead.has(rec.ts)) out.push(rec);
    } catch {
      /* skip a torn/partial line */
    }
  }
  return out;
}

/** Build (embed) one chunk per activity record: "<app> — <window>: <summary> [tags]". */
async function buildActivityIndex(): Promise<Chunk[]> {
  const records = await readActivityRecords();
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

/** The activity index, rebuilt when the JSONL or the tombstone file changes. */
async function getActivityIndex(): Promise<Chunk[]> {
  let jsonlMtime = 0;
  try {
    jsonlMtime = statSync(ACTIVITY_LOG).mtimeMs;
  } catch {
    activityCache = { key: "0:0", chunks: [] }; // no file yet
    return [];
  }
  const key = `${jsonlMtime}:${tombstonesMtime()}`;
  if (activityCache && activityCache.key === key) return activityCache.chunks;
  const chunks = await buildActivityIndex();
  activityCache = { key, chunks };
  return chunks;
}

/** The typed-memories index: one chunk per memory, rebuilt when the store file changes. */
async function getMemoriesIndex(): Promise<Chunk[]> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(MEMORIES_FILE).mtimeMs;
  } catch {
    memoriesCache = { mtimeMs: 0, chunks: [] }; // no memories yet
    return [];
  }
  if (memoriesCache && memoriesCache.mtimeMs === mtimeMs) return memoriesCache.chunks;
  const memories = await loadMemories();
  if (memories.length === 0) {
    memoriesCache = { mtimeMs, chunks: [] };
    return [];
  }
  const docs = memories.map((m) => ({ source: `memory · ${m.type}`, text: m.text }));
  const { embeddings } = await embedMany({ model: embeddingModel(), values: docs.map((d) => d.text) });
  const chunks = docs.map((d, i) => ({ ...d, embedding: embeddings[i] as number[] }));
  memoriesCache = { mtimeMs, chunks };
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
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

/** Top-K most similar chunks for a query — notes + activity + typed memories, cosine over QVAC embeddings. */
export async function searchNotes(query: string, topK = 3): Promise<GraphHit[]> {
  const [notes, activity, memories] = await Promise.all([getIndex(), getActivityIndex(), getMemoriesIndex()]);
  const index = [...notes, ...activity, ...memories];
  if (index.length === 0) return [];
  const { embedding } = await embed({ model: embeddingModel(), value: query });
  return index
    .map((c) => ({ source: c.source, text: c.text, score: cosine(embedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export interface IndexStats {
  noteFiles: number;
  noteChunks: number | null;
  activityRecords: number;
  activityChunks: number | null;
}

/**
 * What the graph currently knows — for the Memory tab header. Chunk counts are read
 * from the CACHES only (`null` = not built yet): stats must never trigger an embed
 * pass (the serve may be offline; browsing memory still has to work).
 */
export async function indexStats(): Promise<IndexStats> {
  return {
    noteFiles: noteFiles().length,
    noteChunks: notesCache?.chunks.length ?? null,
    activityRecords: (await readActivityRecords()).length,
    activityChunks: activityCache?.chunks.length ?? null,
  };
}
