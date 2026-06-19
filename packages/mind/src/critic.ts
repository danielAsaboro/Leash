/**
 * The council's verifier (Layer 3 — Mind).
 *
 * A second, toolless pass over the proposer's answer: it checks every claim in the
 * answer against the source snippets the proposer actually retrieved. This is the
 * cheap insurance that catches a small model citing a [Source N] it didn't support
 * or drifting off the graph — the failure mode a single small model can't self-catch.
 */
import { completion } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import type { Hit } from "@mycelium/senses";
import { COUNCIL_VERIFIER_SYSTEM } from "./prompt.ts";

export interface Verdict {
  verdict: "pass" | "revise";
  /** The verifier's one-line rationale (kept for the audit trail + UX). */
  notes: string;
}

export interface VerifyClaimsParams {
  llmModelId: string;
  answer: string;
  sources: Hit[];
  audit?: AuditLog;
}

/** Verify the answer's claims against its sources. Emits a `completion` (verifier) record. */
export async function verifyClaims({ llmModelId, answer, sources, audit }: VerifyClaimsParams): Promise<Verdict> {
  const sourceText = sources.length
    ? sources.map((h, i) => `[Source ${i + 1}] ${h.content.replace(/\s+/g, " ").trim()}`).join("\n")
    : "(no sources were retrieved)";
  const run = completion({
    modelId: llmModelId,
    history: [
      { role: "system", content: COUNCIL_VERIFIER_SYSTEM },
      { role: "user", content: `SOURCES:\n${sourceText}\n\nANSWER:\n${answer}` },
    ],
    stream: true,
    generationParams: { predict: 200, reasoning_budget: 0 },
  });
  let out = "";
  for await (const t of run.tokenStream) out += t;
  const text = out.trim();
  const verdict: Verdict["verdict"] = /revise/i.test(text.slice(0, 24)) ? "revise" : "pass";
  audit?.record({ event: "completion", modelId: llmModelId, extra: { role: "verifier", verdict } });
  return { verdict, notes: text };
}
