/**
 * Source: accepted council answers (`data/evolve/accepted.jsonl`), written by the
 * council hook when a verdict passed AND the answer cited its sources. These are the
 * system's own best, grounded answers — strong supervised pairs.
 */
import { existsSync, readFileSync } from "node:fs";
import type { TrainingPair } from "../types.ts";
import { ACCEPTED_FILE } from "../paths.ts";

interface AcceptedRecord {
  ts?: string;
  question?: string;
  answer?: string;
}

export function readCouncilPairs(file: string = ACCEPTED_FILE): TrainingPair[] {
  if (!existsSync(file)) return [];
  const pairs: TrainingPair[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let rec: AcceptedRecord;
    try {
      rec = JSON.parse(line) as AcceptedRecord;
    } catch {
      continue;
    }
    const prompt = typeof rec.question === "string" ? rec.question.trim() : "";
    const answer = typeof rec.answer === "string" ? rec.answer.trim() : "";
    if (prompt.length < 5 || answer.length < 12) continue;
    pairs.push({ prompt, answer, source: "council", ref: rec.ts ?? "accepted" });
  }
  return pairs;
}
