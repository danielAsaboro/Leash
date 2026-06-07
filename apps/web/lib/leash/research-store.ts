/**
 * Deep-research run access (server-only) — reads the status/report files the detached
 * child (`scripts/leash-research.mts`) writes under `data/leash-research/`. The web
 * process never runs the research loop itself; it starts the child and polls these
 * files (the model-download pattern — survives dev restarts).
 */
import "server-only";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, DATA_DIR } from "./json-store.ts";

export const RESEARCH_DIR = process.env["LEASH_RESEARCH_DIR"] ?? join(DATA_DIR, "leash-research");

export interface ResearchStatus {
  id: string;
  question: string;
  /** The detached child's pid — lets the dashboard Cancel (SIGTERM) an active run. */
  pid?: number;
  state: "planning" | "searching" | "reading" | "synthesizing" | "done" | "error";
  round: number;
  maxRounds: number;
  searchProvider?: string;
  queries: string[];
  sources: { title: string; url: string }[];
  note?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A run's live status, or null. Marks a child that died mid-run as an honest error. */
export async function researchStatus(id: string): Promise<ResearchStatus | null> {
  if (!ID_RE.test(id)) return null;
  const s = await readJson<ResearchStatus | null>(join(RESEARCH_DIR, `${id}.json`), null);
  if (!s) return null;
  // A non-terminal status untouched for >3 min = the child crashed/was killed.
  if (s.state !== "done" && s.state !== "error" && Date.now() - s.updatedAt > 180_000) {
    return { ...s, state: "error", error: "the research process stopped responding — start it again" };
  }
  return s;
}

/** A run's final report markdown, or null if not written yet. */
export async function researchReport(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return await readFile(join(RESEARCH_DIR, `${id}.md`), "utf8");
  } catch {
    return null;
  }
}

/** All runs, newest first. */
export async function listResearch(): Promise<ResearchStatus[]> {
  let files: string[];
  try {
    files = (await readdir(RESEARCH_DIR)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    return [];
  }
  const runs = await Promise.all(files.map((f) => researchStatus(f.replace(/\.json$/, ""))));
  return runs.filter((r): r is ResearchStatus => r !== null).sort((a, b) => b.startedAt - a.startedAt);
}
