/**
 * Source: typed prefs/facts the assistant captured (`data/leash-memories.json`).
 * The highest-signal training source — these are facts the user explicitly asked to
 * be remembered. Each is paraphrased into several Q→A pairs.
 */
import { existsSync, readFileSync } from "node:fs";
import type { TrainingPair } from "../types.ts";
import { MEMORIES_FILE } from "../paths.ts";
import { paraphraseFact } from "../text.ts";

interface RawMemory {
  id?: string;
  type?: string;
  text?: string;
  source?: string;
}

export function readMemoryPairs(file: string = MEMORIES_FILE): TrainingPair[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const pairs: TrainingPair[] = [];
  for (const item of raw as RawMemory[]) {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    pairs.push(...paraphraseFact(text, "memory", item.id ?? "memory"));
  }
  return pairs;
}
