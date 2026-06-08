/**
 * Council hook: persist accepted, cited answers as future training data.
 *
 * Wired in after `runCouncil` (apps/edge-node, apps/hub): when the verifier PASSED
 * and the answer cited its sources, the (question, answer) becomes a high-quality
 * supervised pair on `data/evolve/accepted.jsonl`, which curate.ts reads next run.
 * The loop closes — the system's own best answers train tomorrow's adapter.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditLog } from "@mycelium/shared";
import { ACCEPTED_FILE } from "./paths.ts";

/** Minimal shape of a council result (avoids a hard @mycelium/mind dep here). */
export interface AcceptedCouncilResult {
  answer: string;
  cited: boolean;
  verifierVerdict: { verdict: "pass" | "revise" };
}

export interface RecordAcceptedParams {
  question: string;
  result: AcceptedCouncilResult;
  audit?: AuditLog;
}

/** Append the pair iff the verdict passed AND the answer cited sources. Returns whether it was recorded. */
export function recordAcceptedAnswer({ question, result, audit }: RecordAcceptedParams): boolean {
  const accept = result.verifierVerdict.verdict === "pass" && result.cited;
  if (!accept) return false;
  const answer = result.answer.trim();
  if (question.trim().length < 5 || answer.length < 12) return false;
  mkdirSync(dirname(ACCEPTED_FILE), { recursive: true });
  appendFileSync(ACCEPTED_FILE, JSON.stringify({ ts: new Date().toISOString(), question: question.trim(), answer }) + "\n");
  audit?.record({ event: "note", extra: { role: "council-hook", accepted: true, question: question.trim() } });
  return true;
}
