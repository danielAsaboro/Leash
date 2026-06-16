/**
 * On-device notifications feed — the standalone analogue of the desktop notifications-store.
 * On a phone there is no daemon raising nudges, so the feed is fed by GENUINE on-device events
 * (a model finished downloading, the mesh connected/dropped, a model failed to load) — never
 * fabricated rows (Rule 4). One JSON file in the app's document directory.
 *
 * Tier mirrors the web: `auto` (logged, pre-read), `notify` (unread badge), `ask` (wants the
 * user's eyes). The drawer bell badge reads unreadCount().
 */
import * as FileSystem from "expo-file-system/legacy";

export type Tier = "auto" | "notify" | "ask";

export type Notification = {
  id: string;
  title: string;
  body: string;
  why?: string;
  tier: Tier;
  read: boolean;
  createdAt: number;
  snoozedUntil?: number;
};

const FILE = `${FileSystem.documentDirectory}notifications.json`;
const MAX = 200; // cap the on-device feed so it can't grow unbounded

function newId(): string {
  return `nt${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function readAll(): Promise<Notification[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const arr = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Notification[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Notification[]): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* best-effort */
  }
}

/** Newest first; snoozed items (snoozedUntil in the future) are filtered from the feed. */
export async function listNotifications(): Promise<Notification[]> {
  const now = Date.now();
  return (await readAll())
    .filter((n) => !n.snoozedUntil || n.snoozedUntil <= now)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Add an event. `auto`-tier lands pre-read (it's a log line, not a demand for attention). */
export async function addNotification(input: {
  title: string;
  body: string;
  why?: string;
  tier?: Tier;
}): Promise<Notification> {
  const tier = input.tier ?? "notify";
  const n: Notification = {
    id: newId(),
    title: input.title,
    body: input.body,
    why: input.why,
    tier,
    read: tier === "auto",
    createdAt: Date.now(),
  };
  const list = await readAll();
  list.unshift(n);
  await writeAll(list);
  return n;
}

export async function markRead(id: string): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((n) => n.id === id);
  if (i === -1) return;
  list[i] = { ...list[i]!, read: true };
  await writeAll(list);
}

export async function markAllRead(): Promise<void> {
  await writeAll((await readAll()).map((n) => ({ ...n, read: true })));
}

/** Hide for `mins` minutes; it returns to the feed once snoozedUntil passes. */
export async function snooze(id: string, mins = 60): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((n) => n.id === id);
  if (i === -1) return;
  list[i] = { ...list[i]!, snoozedUntil: Date.now() + mins * 60_000, read: true };
  await writeAll(list);
}

export async function dismiss(id: string): Promise<void> {
  await writeAll((await readAll()).filter((n) => n.id !== id));
}

export async function clearAll(): Promise<void> {
  await writeAll([]);
}

/** Unread, non-snoozed count — drives the drawer bell badge. */
export async function unreadCount(): Promise<number> {
  const now = Date.now();
  return (await readAll()).filter((n) => !n.read && (!n.snoozedUntil || n.snoozedUntil <= now)).length;
}
