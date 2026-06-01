/**
 * Shared audit logger for the Day 1–3 spike.
 *
 * Emits JSONL records (one per line) under spike/logs/<source>.jsonl matching the
 * hackathon's required audit-log fields (model load/unload, prompt, tokens, TTFT,
 * tok/s). These logs are part of the 3-stage verification evidence bundle.
 *
 * Self-contained on purpose: the AuditRecord shape mirrors @mycelium/shared so the
 * spike runs with no build step (just `tsx`). Keep the two in sync.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(here, "..", "logs");

export interface AuditRecord {
  ts: string;
  source: string;
  event:
    | "model_load"
    | "model_unload"
    | "prompt"
    | "completion"
    | "embedding"
    | "rag_ingest"
    | "rag_search"
    | "finetune_progress"
    | "finetune_result"
    | "delegation"
    | "graph_sync"
    | "pairing"
    | "note";
  modelId?: string;
  modelSrc?: string;
  device?: "cpu" | "gpu";
  prompt?: string;
  tokens?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  durationMs?: number;
  extra?: Record<string, unknown>;
}

export class AuditLog {
  private readonly file: string;
  constructor(public readonly source: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    this.file = join(LOG_DIR, `${source}.jsonl`);
  }

  /** Append one record to the JSONL log and echo a compact line to stdout. */
  record(rec: Omit<AuditRecord, "ts" | "source">): AuditRecord {
    const full: AuditRecord = { ts: new Date().toISOString(), source: this.source, ...rec };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    // Model constants are descriptor objects; show their .name in the console echo
    // (the full descriptor is preserved in the JSONL for the evidence bundle).
    const modelName =
      full.modelSrc && typeof full.modelSrc === "object"
        ? (full.modelSrc as { name?: string }).name ?? "model"
        : full.modelSrc;
    const bits = [
      `· ${full.event}`,
      modelName ? `model=${modelName}` : "",
      full.ttftMs != null ? `ttft=${full.ttftMs}ms` : "",
      full.tokensPerSecond != null ? `tok/s=${full.tokensPerSecond.toFixed(1)}` : "",
      full.tokens != null ? `tokens=${full.tokens}` : "",
      full.durationMs != null ? `dur=${full.durationMs}ms` : "",
    ].filter(Boolean);
    console.log(`📝 ${bits.join("  ")}`);
    return full;
  }

  get path(): string {
    return this.file;
  }
}

/** Wall-clock helper (ms) for measuring durations / TTFT manually. */
export function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
