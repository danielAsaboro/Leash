/**
 * @mycelium/memory — Layer 4 (Memory): "The Understory", the self-improvement loop.
 *
 * curate (real signals → train.jsonl) → train (nightly LoRA via QVAC Fabric) → eval
 * (3 frozen axes, every run logged) → apply (newest evalDelta>=0 adapter) → share
 * (P2P, packages/mesh). Closes the spec's Senses → Mind → Memory → sharper Senses loop.
 *
 * Layering note: index re-exports the full surface (incl. the @qvac/sdk-backed
 * train/eval). The web reads only TYPES from here (erased at build) + plain JSON/JSONL
 * files; it never imports a value path that would pull the SDK into the Next bundle.
 */
export * from "./types.ts";

export { normalizePrompt, paraphraseFact, splitFactLines } from "./text.ts";

export { curateTrainingSet, trainFileExists, MIN_PAIRS } from "./curate.ts";
export type { CurateResult, CurateOptions } from "./curate.ts";

export { loadEvalSet, evalPromptSet } from "./eval-set.ts";

export { runEval } from "./eval.ts";
export type { RunEvalParams } from "./eval.ts";

export { runNightlyLora, DEFAULT_BASE } from "./train.ts";
export type { TrainOutcome, RunNightlyLoraParams, TrainBase } from "./train.ts";

export { latestAdapter, latestAdapterPath, latestManifest } from "./apply.ts";
export type { ResolvedAdapter, ApplyOptions } from "./apply.ts";

export { promoteAdapterToServe, servedAliasForBase } from "./serve-alias.ts";
export type { PromoteResult, PromoteParams } from "./serve-alias.ts";

export { recordAcceptedAnswer } from "./council-hook.ts";
export type { AcceptedCouncilResult, RecordAcceptedParams } from "./council-hook.ts";

// Source readers (used by the smoke + any advanced caller).
export { readMemoryPairs } from "./sources/memories-source.ts";
export { readChatPairs } from "./sources/chats-source.ts";
export { readGraphPairs } from "./sources/graph-source.ts";
export { readCouncilPairs } from "./sources/council-source.ts";
export { readFeedback, readFeedbackPairs } from "./sources/feedback-source.ts";
export type { FeedbackPairs } from "./sources/feedback-source.ts";
