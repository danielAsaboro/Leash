/**
 * On-device conversation store — the mobile analogue of apps/web's file-based chat store
 * (lib/leash/chat-store.ts). Each conversation is one JSON file in the app's document directory;
 * everything stays on the device. Shared by the text chat AND the voice call (spoken turns land
 * in the same conversation, exactly like the web).
 */
import * as FileSystem from "expo-file-system/legacy";

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string;
  telemetry?: { tokens: number; tps: number; ttftMs: number; where: "mesh" | "local"; device?: string };
};

export type ChatRecord = { id: string; createdAt: number; updatedAt: number; title: string; messages: StoredMessage[] };
export type ChatSummary = { id: string; title: string; updatedAt: number; count: number };

const DIR = `${FileSystem.documentDirectory}chats/`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

export function newChatId(): string {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Conversation title = the first user message, trimmed to 60 chars (or "New chat"). */
export function deriveTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  return t ? t.slice(0, 60) : "New chat";
}

export async function listChats(): Promise<ChatSummary[]> {
  await ensureDir();
  const files = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
  const out: ChatSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await FileSystem.readAsStringAsync(DIR + f)) as ChatRecord;
      out.push({ id: rec.id, title: rec.title || deriveTitle(rec.messages), updatedAt: rec.updatedAt, count: rec.messages.length });
    } catch {
      /* skip a corrupt file */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function loadChat(id: string): Promise<ChatRecord | null> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(`${DIR}${id}.json`)) as ChatRecord;
  } catch {
    return null;
  }
}

export async function saveChat(rec: ChatRecord): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(`${DIR}${rec.id}.json`, JSON.stringify(rec));
}

export async function deleteChat(id: string): Promise<void> {
  await FileSystem.deleteAsync(`${DIR}${id}.json`, { idempotent: true }).catch(() => {});
}

export async function clearChats(): Promise<void> {
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
}

/** "2m", "3h", "5d" — compact relative age for the history list. */
export function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
