/**
 * File-based chat persistence (server-only).
 *
 * One self-describing JSON record per chat in a stable, enumerable directory, storing
 * the full `useChat` message parts (text, reasoning, tool calls/results) plus per-message
 * telemetry metadata and chat-level `createdAt`/`updatedAt`.
 *
 * Designed for the planned **"dreaming" service**: a later background pass will enumerate
 * this store (`listChats`), read each `ChatRecord`, and consolidate past conversations into
 * follow-ups / things to work on (feeding the graph / newsroom — roadmap P5). Keeping the
 * format rich + scannable now means that service is a reader, not a migration. The
 * `UIMessage`-shaped storage is deliberate (richer than `ModelMessage`); swap the fs calls
 * for a DB later without changing callers.
 */
import "server-only";
import { generateId } from "ai";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LeashUIMessage, ChatSummary } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data/leash-chats. */
const CHAT_DIR = process.env["LEASH_CHAT_DIR"] ?? join(here, "..", "..", "..", "..", "data", "leash-chats");

export interface ChatRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Optional user-set title; overrides the derived first-message title. */
  title?: string;
  messages: LeashUIMessage[];
  /**
   * Context-compaction state (see compactor.ts). When a thread outgrows the model's
   * window, the oldest messages are summarized into `summary` and the model is sent
   * `[summary + messages.slice(summarizedThrough)]`. The FULL `messages` array is still
   * stored and displayed — only the model's input is compacted, never the record.
   */
  summary?: string;
  summarizedThrough?: number;
}

async function ensureDir(): Promise<void> {
  if (!existsSync(CHAT_DIR)) await mkdir(CHAT_DIR, { recursive: true });
}
const chatFile = (id: string): string => join(CHAT_DIR, `${id}.json`);

/** First user message text, as a short title. */
function deriveTitle(messages: LeashUIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (firstUser?.parts as any[] | undefined)?.filter((p) => p?.type === "text").map((p) => p.text).join(" ") ?? "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean ? (clean.length > 60 ? clean.slice(0, 60) + "…" : clean) : "New chat";
}

/**
 * Mint a new chat id — WITHOUT writing a file. The record is persisted lazily on the
 * first message (`saveChat` in the route's `onFinish`), so abandoned/never-sent chats
 * never clutter the store (and the dreaming pass only ever sees real conversations).
 */
export async function createChat(): Promise<string> {
  return generateId();
}

/** Load a chat's full record, or null if it doesn't exist / is unreadable. */
export async function loadRecord(id: string): Promise<ChatRecord | null> {
  try {
    return JSON.parse(await readFile(chatFile(id), "utf8")) as ChatRecord;
  } catch {
    return null;
  }
}

/** Load a chat's messages (empty if missing). */
export async function loadChat(id: string): Promise<LeashUIMessage[]> {
  return (await loadRecord(id))?.messages ?? [];
}

/** Persist a chat's messages, preserving `createdAt`, `title`, and compaction state. */
export async function saveChat({ chatId, messages }: { chatId: string; messages: LeashUIMessage[] }): Promise<void> {
  await ensureDir();
  const existing = await loadRecord(chatId);
  const now = Date.now();
  const record: ChatRecord = {
    id: chatId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages,
    ...(existing?.title ? { title: existing.title } : {}),
    ...(existing?.summary ? { summary: existing.summary, summarizedThrough: existing.summarizedThrough ?? 0 } : {}),
  };
  await writeFile(chatFile(chatId), JSON.stringify(record, null, 2));
}

/** Persist updated compaction state for a chat (preserves everything else). */
export async function saveSummary(chatId: string, summary: string, summarizedThrough: number): Promise<void> {
  const rec = await loadRecord(chatId);
  if (!rec) return;
  rec.summary = summary;
  rec.summarizedThrough = summarizedThrough;
  rec.updatedAt = Date.now();
  await writeFile(chatFile(chatId), JSON.stringify(rec, null, 2));
}

/**
 * Checkpoint revert: keep only the first `keep` messages, dropping everything after. The
 * transport rebuilds each turn's history from this store, so truncating here is what makes a
 * restore "stick" — the next message continues from the checkpoint. Returns the kept messages.
 */
export async function truncateChat(id: string, keep: number): Promise<LeashUIMessage[]> {
  const rec = await loadRecord(id);
  if (!rec) return [];
  const kept = rec.messages.slice(0, Math.max(0, keep));
  const record: ChatRecord = { ...rec, messages: kept, updatedAt: Date.now() };
  // Drop stale compaction state if it now points past the truncated end (the compactor
  // recomputes a fresh summary on the next over-window turn).
  if (record.summarizedThrough && record.summarizedThrough > kept.length) {
    delete record.summary;
    delete record.summarizedThrough;
  }
  await ensureDir();
  await writeFile(chatFile(id), JSON.stringify(record, null, 2));
  return kept;
}

/** Delete a chat (no-op if already gone). */
export async function deleteChat(id: string): Promise<void> {
  try {
    await rm(chatFile(id));
  } catch {
    /* already gone */
  }
}

/** Set a chat's display title (overrides the derived one). */
export async function renameChat(id: string, title: string): Promise<void> {
  const rec = await loadRecord(id);
  if (!rec) return;
  rec.title = title.trim().slice(0, 120);
  await writeFile(chatFile(id), JSON.stringify(rec, null, 2));
}

/** Whether a chat exists. */
export async function chatExists(id: string): Promise<boolean> {
  return existsSync(chatFile(id));
}

/** All chats, newest-updated first — for the chat list + the dreaming pass. */
export async function listChats(): Promise<ChatSummary[]> {
  if (!existsSync(CHAT_DIR)) return [];
  const files = (await readdir(CHAT_DIR)).filter((f) => f.endsWith(".json"));
  const records = await Promise.all(
    files.map(async (f) => {
      const rec = await loadRecord(f.replace(/\.json$/, ""));
      return rec ? { id: rec.id, createdAt: rec.createdAt, updatedAt: rec.updatedAt, title: rec.title ?? deriveTitle(rec.messages), messageCount: rec.messages.length } : null;
    }),
  );
  return records.filter((r): r is ChatSummary => r !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most-recently-updated chat id, or null if none. */
export async function latestChat(): Promise<string | null> {
  return (await listChats())[0]?.id ?? null;
}

// "To work on" consolidations moved to the task store (`tasks-store.ts`): the dreaming
// pass writes source:"dream" tasks to data/leash-tasks.json, and any legacy
// data/leash-dreams.json is migrated on the store's first load.
