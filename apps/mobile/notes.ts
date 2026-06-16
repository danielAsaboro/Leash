/**
 * On-device markdown notes — the phone's local notebook, the standalone analogue of the desktop
 * Brain's notes. Each note is one JSON file in the app's document directory (title + body + mtime),
 * mirroring chats.ts. Plain on-device storage; nothing leaves the phone.
 */
import * as FileSystem from "expo-file-system/legacy";

export type Note = { id: string; title: string; body: string; updatedAt: number };
export type NoteSummary = { id: string; title: string; updatedAt: number; chars: number };

const DIR = `${FileSystem.documentDirectory}notes/`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

export function newNoteId(): string {
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Title falls back to the first non-empty line of the body, else "Untitled". */
export function deriveTitle(title: string, body: string): string {
  const t = title.trim();
  if (t) return t.slice(0, 80);
  const firstLine = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return firstLine ? firstLine.slice(0, 80) : "Untitled";
}

export async function listNotes(): Promise<NoteSummary[]> {
  await ensureDir();
  const files = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
  const out: NoteSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const n = JSON.parse(await FileSystem.readAsStringAsync(DIR + f)) as Note;
      out.push({ id: n.id, title: deriveTitle(n.title, n.body), updatedAt: n.updatedAt, chars: n.body.length });
    } catch {
      /* skip a corrupt file */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function loadNote(id: string): Promise<Note | null> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(`${DIR}${id}.json`)) as Note;
  } catch {
    return null;
  }
}

export async function saveNote(note: { id: string; title: string; body: string }): Promise<Note> {
  await ensureDir();
  const rec: Note = { id: note.id, title: note.title.trim(), body: note.body, updatedAt: Date.now() };
  await FileSystem.writeAsStringAsync(`${DIR}${rec.id}.json`, JSON.stringify(rec));
  return rec;
}

export async function deleteNote(id: string): Promise<void> {
  await FileSystem.deleteAsync(`${DIR}${id}.json`, { idempotent: true }).catch(() => {});
}

export async function clearNotes(): Promise<void> {
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
}
