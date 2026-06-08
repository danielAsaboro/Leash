/**
 * Curate the training set: gather every real signal → drop 👎-rejected → exclude the
 * frozen eval holdout → dedupe by normalized prompt (priority order) → enforce the
 * min-viable gate → write `data/evolve/train.jsonl` as HF-chat rows.
 *
 * Pure file IO + string ops — NO model, NO GPU — so `memory:smoke` runs offline and
 * the result is reproducible.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditLog } from "@mycelium/shared";
import type { HfChatRow, TrainingPair, TrainingSource } from "./types.ts";
import { SOURCE_PRIORITY } from "./types.ts";
import { TRAIN_FILE } from "./paths.ts";
import { normalizePrompt } from "./text.ts";
import { evalPromptSet } from "./eval-set.ts";
import { readMemoryPairs } from "./sources/memories-source.ts";
import { readChatPairs } from "./sources/chats-source.ts";
import { readGraphPairs } from "./sources/graph-source.ts";
import { readCouncilPairs } from "./sources/council-source.ts";
import { readFeedbackPairs } from "./sources/feedback-source.ts";

/** Default min pairs to train on — below this we skip honestly (no junk adapter). */
export const MIN_PAIRS = 12;

export interface CurateOptions {
  minPairs?: number;
  /** When false, compute the set but don't write train.jsonl (smoke/dry-run). */
  write?: boolean;
  audit?: AuditLog;
}

export interface CurateResult {
  /** Final, deduped, gated pairs (what would be / was written). */
  pairs: TrainingPair[];
  /** True iff `pairs.length >= minPairs` (i.e. training should proceed). */
  ok: boolean;
  minPairs: number;
  counts: {
    gathered: number;
    bySource: Record<TrainingSource, number>;
    excludedHoldout: number;
    excludedFeedback: number;
    deduped: number;
    final: number;
  };
  trainFile: string;
  written: boolean;
}

function toHfRow(p: TrainingPair): HfChatRow {
  return { messages: [{ role: "user", content: p.prompt }, { role: "assistant", content: p.answer }] };
}

export function curateTrainingSet(opts: CurateOptions = {}): CurateResult {
  const minPairs = opts.minPairs ?? MIN_PAIRS;
  const audit = opts.audit;

  // 1. gather every signal
  const memory = readMemoryPairs();
  const chat = readChatPairs();
  const graph = readGraphPairs();
  const council = readCouncilPairs();
  const feedback = readFeedbackPairs();
  const gathered: TrainingPair[] = [...feedback.pairs, ...council, ...memory, ...chat, ...graph];

  const bySource: Record<TrainingSource, number> = {
    feedback: feedback.pairs.length,
    council: council.length,
    memory: memory.length,
    chat: chat.length,
    graph: graph.length,
  };

  // 2. drop 👎-rejected prompts (no correction given)
  const holdout = evalPromptSet();
  let excludedFeedback = 0;
  let excludedHoldout = 0;
  const afterExcludes: TrainingPair[] = [];
  for (const p of gathered) {
    const key = normalizePrompt(p.prompt);
    if (!key) continue;
    if (feedback.exclude.has(key)) { excludedFeedback++; continue; }
    // 3. NEVER train on a frozen eval prompt (the honesty guarantee)
    if (holdout.has(key)) { excludedHoldout++; continue; }
    afterExcludes.push(p);
  }

  // 4. dedupe by normalized prompt, keeping the highest-priority source
  const best = new Map<string, TrainingPair>();
  for (const p of afterExcludes) {
    const key = normalizePrompt(p.prompt);
    const cur = best.get(key);
    if (!cur || SOURCE_PRIORITY[p.source] > SOURCE_PRIORITY[cur.source]) best.set(key, p);
  }
  const deduped = afterExcludes.length - best.size;
  const pairs = [...best.values()];

  const ok = pairs.length >= minPairs;
  let written = false;
  if (opts.write && ok) {
    mkdirSync(dirname(TRAIN_FILE), { recursive: true });
    writeFileSync(TRAIN_FILE, pairs.map((p) => JSON.stringify(toHfRow(p))).join("\n") + "\n");
    written = true;
  }

  const counts = {
    gathered: gathered.length,
    bySource,
    excludedHoldout,
    excludedFeedback,
    deduped,
    final: pairs.length,
  };
  audit?.record({
    event: "curate",
    extra: {
      ...counts,
      ok,
      minPairs,
      written,
      trainFile: written ? TRAIN_FILE : undefined,
      note: ok ? undefined : `below min-viable gate (${pairs.length} < ${minPairs}) — skipping training honestly`,
    },
  });

  return { pairs, ok, minPairs, counts, trainFile: TRAIN_FILE, written };
}

/** True iff a non-empty train.jsonl exists (train.ts guards on this + curate.ok). */
export function trainFileExists(): boolean {
  return existsSync(TRAIN_FILE);
}
