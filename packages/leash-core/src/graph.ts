/**
 * The private context graph for `search_graph`: corpus collection from notes,
 * screen activity, typed memories, and past Leash conversations, indexed through
 * the shared QVAC SDK RAG workspace manager in `@mycelium/senses`.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import {
  defaultRagManifestPath,
  loadEmbeddings,
  loadRagManifest,
  searchRagWorkspace,
  syncRagWorkspace,
  type RagSourceDoc,
} from "@mycelium/senses";
import { tombstonedSet, tombstonesMtime } from "./tombstones.ts";
import { loadMemories, MEMORIES_FILE } from "./memories-store.ts";
import { DATA_DIR, NOTES_DIR, ACTIVITY_LOG, CHATS_DIR } from "./paths.ts";

export { NOTES_DIR, ACTIVITY_LOG, CHATS_DIR };

export const LEASH_RAG_WORKSPACE = "leash-context";
export const LEASH_RAG_MANIFEST = process.env["LEASH_RAG_MANIFEST"] ?? join(DATA_DIR, "rag", "leash-context.manifest.json");

/** One screen-watcher activity record (mirrors apps/leash-watch store.ts). */
export interface ActivityRecord {
  ts: string;
  app: string;
  window: string;
  summary: string;
  tags: string[];
}

let leashEmbModelId: string | undefined;
let leashEmbModelPromise: Promise<string> | undefined;
let leashEmbEnvTried = false;

/** Split a note into paragraph-ish chunks, dropping trivially short fragments. */
export function chunkText(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40);
}

/** Legacy local-context markdown files currently on disk. */
function noteFiles(): string[] {
  if (!existsSync(NOTES_DIR)) return [];
  return readdirSync(NOTES_DIR).filter((n) => n.endsWith(".md")).sort();
}

function collectNoteDocs(files: string[]): RagSourceDoc[] {
  const docs: RagSourceDoc[] = [];
  for (const f of files) {
    const path = join(NOTES_DIR, f);
    let updatedAt: string | undefined;
    try {
      updatedAt = new Date(statSync(path).mtimeMs).toISOString();
    } catch {}
    const chunks = chunkText(readFileSync(path, "utf-8"));
    for (let i = 0; i < chunks.length; i++) {
      docs.push({
        sourceId: `note:${f}:${i}`,
        source: basename(f),
        kind: "note",
        content: chunks[i] as string,
        updatedAt,
      });
    }
  }
  return docs;
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

/** Build one source doc per activity record: "<app> — <window>: <summary> [tags]". */
async function collectActivityDocs(): Promise<RagSourceDoc[]> {
  const records = await readActivityRecords();
  return records.map((r) => {
    const d = new Date(r.ts);
    const hhmm = Number.isNaN(d.getTime())
      ? ""
      : ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const window = r.window ? ` — ${r.window}` : "";
    const tags = Array.isArray(r.tags) && r.tags.length ? ` [${r.tags.join(", ")}]` : "";
    return {
      sourceId: `activity:${r.ts}`,
      source: `activity · ${r.app}${hhmm}`,
      kind: "activity",
      content: `${r.app}${window}: ${r.summary}${tags}`,
      updatedAt: r.ts,
      corpusFingerprint: `${r.ts}:${tombstonesMtime()}`,
    };
  });
}

// ── Chats (recall memory) ──────────────────────────────────────────────────────

/** Caps: bounded embed cost per changed chat, bounded total index size (newest chats win). */
const CHAT_EXCHANGES_PER_CHAT = 60;
const CHAT_CHUNK_CAP = 600;
const CHAT_SIDE_CAP = 700; // chars kept per side of an exchange

interface StoredChatMessage {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

/** Text-parts join of one stored message (tool/reasoning parts are skipped — they can be huge). */
function messageText(m: StoredChatMessage): string {
  return (m.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One "You: … / Leash: …" chunk per user↔assistant exchange (newest kept when over cap). */
function chatExchanges(file: string, rec: { title?: string; updatedAt?: number; messages?: StoredChatMessage[] }): RagSourceDoc[] {
  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  const date = rec.updatedAt ? new Date(rec.updatedAt).toISOString().slice(0, 10) : "";
  const title = (rec.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const source = `chat · ${title || "untitled"}${date ? ` · ${date}` : ""}`;
  const out: RagSourceDoc[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as StoredChatMessage;
    if (m.role !== "user") continue;
    const user = messageText(m).slice(0, CHAT_SIDE_CAP);
    let assistant = "";
    for (let j = i + 1; j < messages.length && (messages[j] as StoredChatMessage).role !== "user"; j++) {
      assistant += (assistant ? " " : "") + messageText(messages[j] as StoredChatMessage);
    }
    const text = `You: ${user}\nLeash: ${assistant.slice(0, CHAT_SIDE_CAP)}`;
    if (text.length > 40) {
      out.push({
        sourceId: `chat:${file}:${i}`,
        source,
        kind: "chat",
        content: text,
        updatedAt: rec.updatedAt ? new Date(rec.updatedAt).toISOString() : undefined,
      });
    }
  }
  return out.slice(-CHAT_EXCHANGES_PER_CHAT);
}

/**
 * The conversation corpus. Bounded by newest chat files first and newest exchanges
 * per chat so sync cost stays finite.
 */
async function collectChatDocs(): Promise<RagSourceDoc[]> {
  let files: { name: string; mtimeMs: number }[];
  try {
    files = readdirSync(CHATS_DIR)
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((name) => ({ name, mtimeMs: statSync(join(CHATS_DIR, name)).mtimeMs }));
  } catch {
    return []; // no chats yet
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first → they win the cap
  const merged: RagSourceDoc[] = [];
  for (const f of files) {
    if (merged.length >= CHAT_CHUNK_CAP) break;
    let docs: RagSourceDoc[] = [];
    try {
      docs = chatExchanges(f.name, JSON.parse(readFileSync(join(CHATS_DIR, f.name), "utf-8")));
    } catch {
      /* torn write / bad record — skip this chat, retry on its next mtime change */
    }
    merged.push(...docs.slice(0, Math.max(0, CHAT_CHUNK_CAP - merged.length)));
  }
  return merged;
}

/** The typed-memory corpus: one source doc per memory. */
async function collectMemoryDocs(): Promise<RagSourceDoc[]> {
  const memories = await loadMemories();
  return memories.map((m) => ({
    sourceId: `memory:${m.id}`,
    source: `memory · ${m.type}`,
    kind: "memory",
    content: m.text,
    updatedAt: new Date(m.updatedAt).toISOString(),
    corpusFingerprint: `${m.updatedAt}`,
  }));
}

export interface GraphHit {
  source: string;
  text: string;
  score: number;
  kind?: string;
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

export async function collectLeashRagDocs(): Promise<RagSourceDoc[]> {
  const files = noteFiles();
  const notes = collectNoteDocs(files);
  const activity = await collectActivityDocs();
  const memories = await collectMemoryDocs();
  const chats = await collectChatDocs();
  return [...notes, ...activity, ...memories, ...chats];
}

async function leashEmbeddingModelId(): Promise<string> {
  if (leashEmbModelId) return leashEmbModelId;
  if (!leashEmbModelPromise) {
    leashEmbModelPromise = (async () => {
      const configured = !leashEmbEnvTried ? process.env["LEASH_RAG_EMB_MODEL_ID"] : undefined;
      leashEmbEnvTried = true;
      const modelId = configured || (await loadEmbeddings());
      leashEmbModelId = modelId;
      return modelId;
    })().finally(() => {
      leashEmbModelPromise = undefined;
    });
  }
  return leashEmbModelPromise;
}

/** QVAC model ids belong to one worker lifetime. A dashboard serve restart invalidates a
 * previously cached id even though the embedding alias is loaded again. */
export function isStaleEmbeddingModelError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /model with id ["']?[^"']+["']? not found/i.test(message);
}

async function recoverEmbeddingModelId(staleId: string): Promise<string> {
  // The equality guard lets concurrent search_graph calls share one reload. A second caller that
  // observes the replacement simply reuses it instead of starting another SDK load.
  if (leashEmbModelId === staleId) leashEmbModelId = undefined;
  return leashEmbeddingModelId();
}

async function searchNotesWithModel(input: {
  docs: RagSourceDoc[];
  embModelId: string;
  query: string;
  topK: number;
  kinds?: string[];
}) {
  await syncRagWorkspace({
    embModelId: input.embModelId,
    workspace: LEASH_RAG_WORKSPACE,
    manifestPath: LEASH_RAG_MANIFEST || defaultRagManifestPath(LEASH_RAG_WORKSPACE),
    docs: input.docs,
  });
  return searchRagWorkspace({
    embModelId: input.embModelId,
    workspace: LEASH_RAG_WORKSPACE,
    manifestPath: LEASH_RAG_MANIFEST || defaultRagManifestPath(LEASH_RAG_WORKSPACE),
    query: input.query,
    // A source-kind filter is applied after the SDK search, so retrieve a bounded wider candidate
    // pool first. This prevents an exact echo in a recent chat from hiding an actual note.
    topK: input.kinds?.length ? Math.max(16, Math.min(64, input.topK * 8)) : Math.max(1, Math.min(8, input.topK)),
  });
}

/** Exact device/batch/reference ids are poor semantic-search queries: a vector can prefer another
 * numeric measurement. Put literal identifier matches ahead of cosine-ranked results. */
export function exactIdentifierGraphHits(query: string, docs: RagSourceDoc[]): GraphHit[] {
  const ids = [...new Set(
    (query.match(/\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/gi) ?? [])
      .map((value) => value.toLowerCase()),
  )];
  if (ids.length === 0) return [];
  return docs
    .map((doc) => {
      const text = doc.content.toLowerCase();
      const matches = ids.filter((id) => text.includes(id)).length;
      return matches > 0
        ? { source: doc.source, text: doc.content, score: 2 + matches, ...(doc.kind ? { kind: doc.kind } : {}) }
        : null;
    })
    .filter((hit): hit is GraphHit => hit !== null)
    .sort((left, right) => right.score - left.score);
}

/** Top-K most similar chunks for a query — notes + activity + typed memories + past chats, via QVAC SDK RAG. */
export async function searchNotes(query: string, topK = 3, kinds?: string[]): Promise<GraphHit[]> {
  const docs = await collectLeashRagDocs();
  if (docs.length === 0) return [];
  let embModelId = await leashEmbeddingModelId();
  let hits: Awaited<ReturnType<typeof searchNotesWithModel>>;
  try {
    hits = await searchNotesWithModel({ docs, embModelId, query, topK, ...(kinds ? { kinds } : {}) });
  } catch (error) {
    if (!isStaleEmbeddingModelError(error)) throw error;
    embModelId = await recoverEmbeddingModelId(embModelId);
    hits = await searchNotesWithModel({ docs, embModelId, query, topK, ...(kinds ? { kinds } : {}) });
  }
  const literalHits = exactIdentifierGraphHits(query, docs);
  const semanticHits: GraphHit[] = hits.map((hit) => ({
    source: hit.source ?? "unknown",
    text: hit.content,
    score: hit.score,
    ...(hit.kind ? { kind: hit.kind } : {}),
  }));
  const allowed = kinds?.length ? new Set(kinds) : null;
  const seen = new Set<string>();
  return [...literalHits, ...semanticHits]
    .filter((hit) => !allowed || (typeof hit.kind === "string" && allowed.has(hit.kind)))
    .filter((hit) => {
      const key = `${hit.source}\u0000${hit.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, topK))
    .map((hit) => ({ source: hit.source, text: hit.text, score: hit.score, ...(hit.kind ? { kind: hit.kind } : {}) }));
}

export interface IndexStats {
  noteFiles: number;
  noteChunks: number | null;
  activityRecords: number;
  activityChunks: number | null;
}

/**
 * What the graph currently knows — for the Memory tab header. Chunk counts are read
 * from the CACHES only (`null` = not built yet): stats must never trigger an embed pass.
 */
export async function indexStats(): Promise<IndexStats> {
  const manifest = loadRagManifest(LEASH_RAG_MANIFEST || defaultRagManifestPath(LEASH_RAG_WORKSPACE), LEASH_RAG_WORKSPACE);
  const sources = Object.values(manifest.sources);
  return {
    noteFiles: noteFiles().length,
    noteChunks: sources.filter((s) => s.kind === "note").reduce((sum, s) => sum + s.chunks.length, 0),
    activityRecords: (await readActivityRecords()).length,
    activityChunks: sources.filter((s) => s.kind === "activity").reduce((sum, s) => sum + s.chunks.length, 0),
  };
}
