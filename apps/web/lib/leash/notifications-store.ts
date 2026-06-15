/**
 * Notifications store (server-only) — `data/leash-notifications.json`.
 *
 * The "voice" of the proactive assistant: the heartbeat turns a surfaced proposal into a Notification
 * the user sees in the bell feed (+ optional OS toast). Mutable (read / snooze / dismiss / always-auto),
 * so it uses the codebase's atomic JSON-array store pattern (tasks-store/schedules-store) — read,
 * modify, atomic write — rather than append-only JSONL. Bounded: newest CAP retained on each add.
 */
import "server-only";
import { generateId } from "ai";
import { join } from "node:path";
import { readJson, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import type { Tier } from "./classify.ts";

export const NOTIFICATIONS_FILE = process.env["LEASH_NOTIFICATIONS_FILE"] ?? join(DATA_DIR, "leash-notifications.json");

/** Most notifications retained on disk (newest-first prune on each add). */
const CAP = 200;

export type NotificationType = "nudge" | "suggestion" | "alert" | "digest" | "done";
export type NotificationActionKind = "open_chat" | "snooze" | "dismiss" | "approve" | "always_auto";

export interface NotificationAction {
  kind: NotificationActionKind;
  label: string;
}

export interface Notification {
  id: string;
  ts: number;
  type: NotificationType;
  tier: Tier;
  title: string;
  body: string;
  /** Why this surfaced — the explainability line (classifier reason / on-goal). */
  why?: string;
  /** Which goal it serves, if the heartbeat tied it to one. */
  goalRef?: string;
  /** Proposal signature — powers "always do this" (pins the tier) + dedup. */
  sig?: string;
  actions: NotificationAction[];
  read: boolean;
  readAt?: number;
  /** Hidden from the feed until this time (snooze). */
  snoozedUntil?: number;
  dismissed?: boolean;
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<Notification[]> {
  const raw = await readJson<Notification[]>(NOTIFICATIONS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

/** The default action set for a delivery tier. */
function actionsFor(tier: Tier): NotificationAction[] {
  const base: NotificationAction[] = [
    { kind: "open_chat", label: "Open chat" },
    { kind: "snooze", label: "Snooze" },
    { kind: "dismiss", label: "Dismiss" },
    { kind: "always_auto", label: "Always auto" },
  ];
  // Ask-tier carries an explicit Approve up front (approve-before-acting).
  return tier === "ask" ? [{ kind: "approve", label: "Approve" }, ...base] : base;
}

export interface NewNotification {
  type?: NotificationType;
  tier: Tier;
  title: string;
  body: string;
  why?: string;
  goalRef?: string;
  sig?: string;
}

/**
 * Add a notification. `auto`-tier arrives pre-read (in the feed history but no badge ping); every other
 * tier is unread. Returns the created record. Caller is responsible for not adding suppressed proposals.
 */
export async function addNotification(input: NewNotification): Promise<Notification> {
  return withLock(async () => {
    const all = await readAll();
    const n: Notification = {
      id: generateId(),
      ts: Date.now(),
      type: input.type ?? "suggestion",
      tier: input.tier,
      title: input.title.slice(0, 160),
      body: input.body.slice(0, 4000),
      ...(input.why ? { why: input.why.slice(0, 200) } : {}),
      ...(input.goalRef ? { goalRef: input.goalRef.slice(0, 160) } : {}),
      ...(input.sig ? { sig: input.sig } : {}),
      actions: actionsFor(input.tier),
      read: input.tier === "auto",
      ...(input.tier === "auto" ? { readAt: Date.now() } : {}),
    };
    const next = [n, ...all].slice(0, CAP);
    await writeJson(NOTIFICATIONS_FILE, next);
    invalidateJsonCache(NOTIFICATIONS_FILE);
    return n;
  });
}

/** Visible notifications, newest first — excludes dismissed and currently-snoozed. */
export async function listNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
  const now = Date.now();
  let all = (await readAll()).filter((n) => !n.dismissed && !(n.snoozedUntil && n.snoozedUntil > now));
  if (opts.unreadOnly) all = all.filter((n) => !n.read);
  all.sort((a, b) => b.ts - a.ts);
  return opts.limit ? all.slice(0, opts.limit) : all;
}

/** Count of unread, non-dismissed, non-snoozed notifications (the bell badge). */
export async function unreadCount(): Promise<number> {
  return (await listNotifications({ unreadOnly: true })).length;
}

export async function getNotification(id: string): Promise<Notification | null> {
  return (await readAll()).find((n) => n.id === id) ?? null;
}

async function patch(id: string, fn: (n: Notification) => void): Promise<Notification | null> {
  return withLock(async () => {
    const all = await readAll();
    const n = all.find((x) => x.id === id);
    if (!n) return null;
    fn(n);
    await writeJson(NOTIFICATIONS_FILE, all);
    invalidateJsonCache(NOTIFICATIONS_FILE);
    return n;
  });
}

export async function markRead(id: string): Promise<Notification | null> {
  return patch(id, (n) => {
    n.read = true;
    n.readAt = Date.now();
  });
}

export async function markAllRead(): Promise<void> {
  await withLock(async () => {
    const all = await readAll();
    const now = Date.now();
    for (const n of all)
      if (!n.read) {
        n.read = true;
        n.readAt = now;
      }
    await writeJson(NOTIFICATIONS_FILE, all);
    invalidateJsonCache(NOTIFICATIONS_FILE);
  });
}

export async function snooze(id: string, ms: number): Promise<Notification | null> {
  return patch(id, (n) => {
    n.snoozedUntil = Date.now() + Math.max(60_000, ms);
    n.read = true;
    n.readAt = Date.now();
  });
}

export async function dismiss(id: string): Promise<Notification | null> {
  return patch(id, (n) => {
    n.dismissed = true;
    n.read = true;
    n.readAt = Date.now();
  });
}
