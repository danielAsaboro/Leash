/**
 * Default-schedule seeding (server-only) — idempotent.
 *
 * The leash-cron era seeded the default schedules into `leash-schedule.json` on the first
 * `listSchedules`. Now they're seeded into mcp-cron the same way: seed-IF-ABSENT (matched by
 * name), so a restart never duplicates them and a user who deleted a seed doesn't get it back.
 * Called once per process from `listSchedules` (the daemon is up by then — cron-client ensures it).
 *
 * The three defaults match the originals exactly: dream + evolve nightly at 03:30 (cron
 * serializes them so they run back-to-back on the idle GPU), and the 30-minute proactive
 * heartbeat with a 09:00–22:00 active window and a 12/day budget.
 */
import "server-only";
import { renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cronList } from "./cron-client.ts";
import { createSchedule, SCHEDULE_FILE, type ScheduleEntry } from "./schedules-store.ts";

type SeedSpec = Omit<ScheduleEntry, "id" | "createdAt" | "updatedAt">;

export const DEFAULT_SEEDS: SeedSpec[] = [
  {
    name: "Dream — consolidate chats into tasks",
    enabled: true,
    kind: "job",
    schedule: { type: "daily", at: "03:30" },
    job: { script: "dream" },
  },
  {
    name: "Evolve — nightly on-device LoRA (better at you)",
    enabled: true,
    kind: "job",
    schedule: { type: "daily", at: "03:30" },
    job: { script: "evolve" },
  },
  {
    name: "Heartbeat — proactive check against your goals",
    enabled: true,
    kind: "heartbeat",
    schedule: { type: "interval", minutes: 30 },
    heartbeat: { activeHours: { start: "09:00", end: "22:00" }, maxPerDay: 12 },
  },
];

/** Names already present in mcp-cron (read from the Leash metadata each task carries). */
async function existingScheduleNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const t of await cronList()) {
    if (!t.description) continue;
    try {
      const name = (JSON.parse(t.description) as { name?: string }).name;
      if (name) names.add(name);
    } catch {
      /* foreign task */
    }
  }
  return names;
}

/**
 * One-time migration off leash-cron: import any existing `leash-schedule.json` entries (a user's
 * custom schedules from the old daemon) into mcp-cron — skipping names already present — then rename
 * the file to `.migrated` so it never runs again. The default seeds (dream/evolve/heartbeat) carried
 * the same names, so they de-dupe against whatever seeding creates. Best-effort + idempotent: if the
 * file is gone or already `.migrated`, this is a no-op.
 */
async function migrateLegacySchedules(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(SCHEDULE_FILE, "utf8");
  } catch {
    return; // no legacy file (fresh install, or already migrated)
  }
  let legacy: Partial<ScheduleEntry>[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    legacy = Array.isArray(parsed) ? (parsed as Partial<ScheduleEntry>[]) : [];
  } catch {
    legacy = [];
  }
  const present = await existingScheduleNames();
  for (const e of legacy) {
    if (!e || typeof e.name !== "string" || !e.kind || !e.schedule) continue;
    if (present.has(e.name)) continue;
    // strip the leash-cron-era id/timestamps — mcp-cron assigns its own id
    const { id: _id, createdAt: _c, updatedAt: _u, ...spec } = e as ScheduleEntry;
    await createSchedule(spec as SeedSpec).catch(() => {});
    present.add(e.name);
  }
  // Retire the file so this never re-runs (rename, don't delete — keep it as evidence).
  try {
    renameSync(SCHEDULE_FILE, `${SCHEDULE_FILE}.migrated`);
  } catch {
    /* already renamed / gone */
  }
}

/** Create any default schedule that isn't already present (by name). Safe to call repeatedly. */
export async function seedDefaultSchedules(): Promise<void> {
  // First migrate any leash-cron-era custom schedules, THEN seed defaults (both seed-if-absent).
  await migrateLegacySchedules();
  const present = await existingScheduleNames();
  for (const seed of DEFAULT_SEEDS) {
    if (present.has(seed.name)) continue;
    await createSchedule(seed).catch(() => {
      /* best-effort: a transient daemon hiccup just means we retry next process */
    });
  }
}
