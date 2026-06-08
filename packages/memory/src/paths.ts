/**
 * Layer 4 — Memory ("The Understory"): the on-disk path contract.
 *
 * Every process that touches the evolution loop — the `evolve` CLI, the nightly
 * cron, the mesh adapter share, and the web `/grow` reader — imports its paths from
 * HERE. One module, one source of truth, so a path never drifts between producer and
 * consumer.
 *
 * Anchored to the repo root via `import.meta.url` (the senses/edge convention), so it
 * resolves the same regardless of `process.cwd()`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (packages/memory/src → ../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");
/** Shared per-device data dir (git-ignored except the checked-in eval fixtures). */
export const DATA_DIR = join(REPO_ROOT, "data");
/** Where @mycelium/memory writes its audit JSONL (per-package evidence bundle). */
export const LOG_DIR = join(here, "..", "logs");

// ── input signals (the real training data already on disk) ──────────────────────
/** Typed prefs/facts the assistant captured — the highest-signal source. */
export const MEMORIES_FILE = join(DATA_DIR, "leash-memories.json");
/** Per-chat transcripts (`{messages:[{role,parts,metadata}]}`). */
export const CHATS_DIR = join(DATA_DIR, "leash-chats");
/** Markdown notes the senses graph ingests — read as graph facts WITHOUT opening the
 *  Autobase corestore (the registry is single-process / fd-locked; see CLAUDE.md). */
export const NOTES_DIR = join(DATA_DIR, "notes");
/** Optional plain-JSONL GraphStore export (best-effort; absent when the graph only
 *  lives in the corestore). Never the corestore itself. */
export const GRAPH_JSONL = join(DATA_DIR, "graph.jsonl");
/** Web 👍/👎 + corrections, appended by the feedback route. */
export const FEEDBACK_FILE = join(DATA_DIR, "leash-feedback.jsonl");

// ── evolve workspace ────────────────────────────────────────────────────────────
export const EVOLVE_DIR = join(DATA_DIR, "evolve");
/** Generated HF-chat rows the finetune trains on. */
export const TRAIN_FILE = join(EVOLVE_DIR, "train.jsonl");
/** Frozen, checked-in eval fixtures — NEVER trained on (enforced in curate.ts). */
export const EVAL_DIR = join(EVOLVE_DIR, "eval");
export const EVAL_RECALL_FILE = join(EVAL_DIR, "eval-v1.recall.jsonl");
export const EVAL_PREFERENCE_FILE = join(EVAL_DIR, "eval-v1.preference.jsonl");
export const EVAL_STYLE_FILE = join(EVAL_DIR, "eval-v1.style.jsonl");
/** Append-only scored runs (base AND adapter) — the growth-chart source. */
export const EVAL_RUNS_FILE = join(EVOLVE_DIR, "eval-runs.jsonl");
/** Accepted, cited council answers (the council hook). */
export const ACCEPTED_FILE = join(EVOLVE_DIR, "accepted.jsonl");
/** Scratch dir for finetune checkpoints (discardable). */
export const CHECKPOINT_DIR = join(EVOLVE_DIR, "checkpoints");

// ── adapters (one versioned dir each) ───────────────────────────────────────────
export const ADAPTERS_DIR = join(DATA_DIR, "adapters");
/** The serve config Leash edits + hypha reads (wrapped by qvac.config.mjs, which
 *  expands `~/`). The `qwen3-4b-me` alias is written here when a promotable adapter
 *  lands. Lives at the repo root, alongside qvac.config.mjs. */
export const CONFIG_BASE = join(REPO_ROOT, "qvac.config.base.json");
export const adapterDir = (version: string): string => join(ADAPTERS_DIR, version);
/** Canonical adapter filename inside a version dir (what the manifest references). */
export const adapterGguf = (version: string): string => join(adapterDir(version), "adapter.gguf");
/** Plain JSON the web layer reads (never a corestore). */
export const adapterManifest = (version: string): string => join(adapterDir(version), "manifest.json");
