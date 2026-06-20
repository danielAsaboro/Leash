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
  leashEmbModelId = process.env["LEASH_RAG_EMB_MODEL_ID"] || (await loadEmbeddings());
  return leashEmbModelId;
}

/** Top-K most similar chunks for a query — notes + activity + typed memories + past chats, via QVAC SDK RAG. */
export async function searchNotes(query: string, topK = 3): Promise<GraphHit[]> {
  const docs = await collectLeashRagDocs();
  if (docs.length === 0) return [];
  const embModelId = await leashEmbeddingModelId();
  await syncRagWorkspace({
    embModelId,
    workspace: LEASH_RAG_WORKSPACE,
    manifestPath: LEASH_RAG_MANIFEST || defaultRagManifestPath(LEASH_RAG_WORKSPACE),
    docs,
  });
  const hits = await searchRagWorkspace({
    embModelId,
    workspace: LEASH_RAG_WORKSPACE,
    manifestPath: LEASH_RAG_MANIFEST || defaultRagManifestPath(LEASH_RAG_WORKSPACE),
    query,
    topK: Math.max(1, Math.min(8, topK)),
  });
  return hits.map((hit) => ({ source: hit.source ?? "unknown", text: hit.content, score: hit.score }));
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
