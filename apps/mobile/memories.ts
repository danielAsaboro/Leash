/**
 * On-device memory store — the mobile analogue of the web's memories-store (packages/leash-core).
 * Atomic facts the assistant should carry between conversations, persisted as one JSON file in the
 * app's document directory. The enabled memories are composed into the chat system prompt (see
 * App.tsx → buildSystem), which is the proof that the Brain → Memory tab is real, not decoration.
 *
 * The web store has five memory types; on a standalone phone we keep the two the user actually
 * curates by hand — `preference` and `fact` — with a one-tap toggle between them.
 */
import * as FileSystem from "expo-file-system/legacy";

export type MemoryType = "preference" | "fact";

export type Memory = {
  id: string;
  type: MemoryType;
  text: string;
  createdAt: number;
  updatedAt: number;
};

const FILE = `${FileSystem.documentDirectory}memories.json`;

function newId(): string {
  return `mem${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function readAll(): Promise<Memory[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const arr = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Memory[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Memory[]): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(list));
  } catch {
    /* best-effort — the session still works without persistence */
  }
}

/** Newest first. */
export async function listMemories(): Promise<Memory[]> {
  const list = await readAll();
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function addMemory(type: MemoryType, text: string): Promise<Memory> {
  const t = text.trim();
  const now = Date.now();
  const mem: Memory = { id: newId(), type, text: t, createdAt: now, updatedAt: now };
  const list = await readAll();
  list.push(mem);
  await writeAll(list);
  return mem;
}

export async function updateMemory(id: string, patch: Partial<Pick<Memory, "type" | "text">>): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((m) => m.id === id);
  if (i === -1) return;
  list[i] = { ...list[i]!, ...patch, text: (patch.text ?? list[i]!.text).trim(), updatedAt: Date.now() };
  await writeAll(list);
}

export async function deleteMemory(id: string): Promise<void> {
  await writeAll((await readAll()).filter((m) => m.id !== id));
}

export async function clearMemories(): Promise<void> {
  await FileSystem.deleteAsync(FILE, { idempotent: true }).catch(() => {});
}

export async function toggleType(id: string): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((m) => m.id === id);
  if (i === -1) return;
  list[i] = { ...list[i]!, type: list[i]!.type === "preference" ? "fact" : "preference", updatedAt: Date.now() };
  await writeAll(list);
}
