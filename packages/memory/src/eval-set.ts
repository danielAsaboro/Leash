/**
 * Load the FROZEN, checked-in eval fixtures (`data/evolve/eval/eval-v1.*.jsonl`).
 *
 * These are versioned and never trained on — curate.ts excludes any training pair
 * whose prompt collides with one of these (see `evalPromptSet`). That exclusion is
 * what makes the growth chart honest: the adapter is scored on questions it has
 * provably never seen.
 */
import { existsSync, readFileSync } from "node:fs";
import type { EvalSet, PreferenceEvalItem, RecallEvalItem, StyleEvalItem } from "./types.ts";
import { EVAL_PREFERENCE_FILE, EVAL_RECALL_FILE, EVAL_STYLE_FILE } from "./paths.ts";
import { normalizePrompt } from "./text.ts";

function readJsonl<T>(file: string, ok: (v: unknown) => v is T): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (ok(v)) out.push(v);
    } catch {
      // lenient: skip malformed line
    }
  }
  return out;
}

const isRecall = (v: unknown): v is RecallEvalItem =>
  typeof v === "object" && v !== null && typeof (v as RecallEvalItem).prompt === "string" && Array.isArray((v as RecallEvalItem).mustMatch);
const isPreference = (v: unknown): v is PreferenceEvalItem =>
  typeof v === "object" && v !== null && typeof (v as PreferenceEvalItem).prompt === "string";
const isStyle = (v: unknown): v is StyleEvalItem =>
  typeof v === "object" && v !== null && typeof (v as StyleEvalItem).prompt === "string" && typeof (v as StyleEvalItem).styleRef === "string";

export function loadEvalSet(): EvalSet {
  return {
    recall: readJsonl(EVAL_RECALL_FILE, isRecall),
    preference: readJsonl(EVAL_PREFERENCE_FILE, isPreference),
    style: readJsonl(EVAL_STYLE_FILE, isStyle),
  };
}

/** Normalized prompts of every eval item — the holdout set curate.ts excludes. */
export function evalPromptSet(set: EvalSet = loadEvalSet()): Set<string> {
  const prompts = [
    ...set.recall.map((i) => i.prompt),
    ...set.preference.map((i) => i.prompt),
    ...set.style.map((i) => i.prompt),
  ];
  return new Set(prompts.map(normalizePrompt));
}
