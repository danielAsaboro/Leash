/**
 * Audit logger shared across all Mycelium layers and apps.
 *
 * Emits JSONL records (one per line) under a caller-chosen log directory,
 * matching the hackathon's required audit-log fields (model load/unload, prompt,
 * tokens, TTFT, tok/s). These logs are part of the 3-stage verification evidence
 * bundle (CLAUDE.md § Audit-log requirement).
 *
 * This is the canonical implementation. `spike/lib/audit-log.ts` keeps a
 * self-contained copy on purpose so the spike runs with no build step (just
 * `tsx`); the two share the `AuditRecord` shape — keep them in sync.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditRecord } from "./index.ts";

export class AuditLog {
  private readonly file: string;

  /**
   * @param source  Subsystem/app emitting records (e.g. "hub", "edge-node").
   * @param logDir  Directory to write `<source>.jsonl` into. Each app passes its
   *                own `logs/` so evidence stays scoped per device/process.
   */
  constructor(
    public readonly source: string,
    logDir: string,
  ) {
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, `${source}.jsonl`);
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
