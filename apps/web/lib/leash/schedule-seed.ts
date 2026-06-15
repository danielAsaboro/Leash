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
import { cronList } from "./cron-client.ts";
import { createSchedule, type ScheduleEntry } from "./schedules-store.ts";

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

/** Create any default schedule that isn't already present (by name). Safe to call repeatedly. */
export async function seedDefaultSchedules(): Promise<void> {
  const present = await existingScheduleNames();
  for (const seed of DEFAULT_SEEDS) {
    if (present.has(seed.name)) continue;
    await createSchedule(seed).catch(() => {
      /* best-effort: a transient daemon hiccup just means we retry next process */
    });
  }
}
