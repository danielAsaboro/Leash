/**
 * Layer 4 — Memory: the data contracts shared across curate → train → eval → apply
 * → share. Kept dependency-free (no @qvac/sdk import) so the web reader and the
 * no-GPU smoke can use them without pulling in the runtime.
 */

/** Which real signal a training pair came from (drives dedupe priority). */
export type TrainingSource = "feedback" | "council" | "memory" | "chat" | "graph";

/** Dedupe priority: a higher number wins when two pairs normalize to the same prompt. */
export const SOURCE_PRIORITY: Record<TrainingSource, number> = {
  feedback: 4,
  council: 3,
  memory: 2,
  chat: 1,
  graph: 0,
};

/** A curated example, pre-serialization. */
export interface TrainingPair {
  prompt: string;
  answer: string;
  source: TrainingSource;
  /** Provenance for the audit trail (chat id, memory id, note file, …). */
  ref?: string;
}

// ── HF-chat row (the on-disk training format finetune reads) ────────────────────
export interface HfChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface HfChatRow {
  messages: HfChatMessage[];
}

// ── eval fixtures (frozen, checked-in) ──────────────────────────────────────────
export type EvalAxis = "recall" | "preference" | "style";

/** personal-fact recall: pass iff the answer contains ANY of `mustMatch` (ci). */
export interface RecallEvalItem {
  prompt: string;
  mustMatch: string[];
}
/** preference adherence: deterministic anchors. */
export interface PreferenceEvalItem {
  prompt: string;
  mustContain?: string[];
  mustNotContain?: string[];
}
/** style match: embedding cosine between the answer and a reference in the user's voice. */
export interface StyleEvalItem {
  prompt: string;
  styleRef: string;
}
export interface EvalSet {
  recall: RecallEvalItem[];
  preference: PreferenceEvalItem[];
  style: StyleEvalItem[];
}

// ── eval results ────────────────────────────────────────────────────────────────
export interface AxisScore {
  axis: EvalAxis;
  /** 0..1: pass-fraction (recall/preference) or mean cosine clamped to [0,1] (style). */
  score: number;
  total: number;
  passed: number;
  /** Per-item detail incl. the OPTIONAL local-judge notes — never the headline. */
  detail?: unknown;
}

/** One scored model on the fixed eval set. Appended unconditionally to eval-runs.jsonl. */
export interface EvalRun {
  ts: string;
  /** "base" or the adapter version. */
  label: string;
  /** Model constant name (e.g. "QWEN3_4B_INST_Q4_K_M"). */
  model: string;
  adapterPath?: string;
  axes: AxisScore[];
  /** Mean of the deterministic axis scores — the headline number for evalDelta. */
  overall: number;
}

/** Sidecar JSON for a versioned adapter (read by apply.ts, the web, and the mesh). */
export interface AdapterManifest {
  version: string;
  baseModel: string;
  /** Adapter filename relative to the version dir ("adapter.gguf"). */
  adapterFile: string;
  sha256: string;
  sizeBytes: number;
  trainPairs: number;
  createdAt: string;
  base: EvalRun;
  adapter: EvalRun;
  /** adapter.overall − base.overall. Only >= 0 is promotable by apply.ts. */
  evalDelta: number;
}

/** A web feedback record (one JSONL line in leash-feedback.jsonl). */
export interface FeedbackRecord {
  ts: string;
  messageId: string;
  chatId?: string;
  rating: "up" | "down";
  prompt: string;
  answer: string;
  /** Present on a 👎 when the user typed what the answer SHOULD have been. */
  correction?: string;
}
