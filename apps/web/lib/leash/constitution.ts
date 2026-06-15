/**
 * The constitution store — read/write the three editable markdown files the proactive assistant
 * judges everything against: `soul.md` (who the user is), `goals.md` (where they're going, ≤5
 * goals), `heartbeat.md` (what to watch each cycle). Per-user-scoped (the LEASH_*_FILE env vars,
 * set by scope.mjs, point each user's scope at its own files). Server-only — plain fs, no SDK.
 *
 * Soul + goals fold into the chat system prompt on EVERY turn (goal-aware chat, not only
 * heartbeats); heartbeat.md drives the autonomous loop's checklist (see /api/leash/heartbeat).
 */
import "server-only";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SOUL_FILE, GOALS_FILE, HEARTBEAT_FILE } from "@mycelium/leash-core/paths";

export type ConstitutionField = "soul" | "goals" | "heartbeat";

const FILES: Record<ConstitutionField, string> = { soul: SOUL_FILE, goals: GOALS_FILE, heartbeat: HEARTBEAT_FILE };

/** Max bytes kept per file — bounds the system-prompt cost of folding soul + goals into every turn. */
const MAX_BYTES = 16_000;

export interface Constitution {
  soul: string;
  goals: string;
  heartbeat: string;
}

async function readMarkdown(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return ""; // unseeded / missing → empty, never throw
  }
}

async function writeMarkdown(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file); // atomic
}

/** Read all three constitution files at once (a missing file reads as ""). */
export async function getConstitution(): Promise<Constitution> {
  const [soul, goals, heartbeat] = await Promise.all([readMarkdown(SOUL_FILE), readMarkdown(GOALS_FILE), readMarkdown(HEARTBEAT_FILE)]);
  return { soul, goals, heartbeat };
}

/** Overwrite one constitution file atomically (size-capped to keep the system prompt bounded). */
export async function setConstitutionField(field: ConstitutionField, content: string): Promise<void> {
  await writeMarkdown(FILES[field], content.slice(0, MAX_BYTES));
}
