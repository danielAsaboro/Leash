/**
 * MedPsy health-record consult (Layer 3 — Mind · Psy Models track).
 *
 * A real specialized-model workflow, not a keyword model-swap: the MedPsy model
 * (MedGemma 4B, the `medpsy` alias) answers a health question **grounded in the
 * user's own private health records**, retrieved over RAG, with [Source N]
 * citations, a claim-verification pass (the council's critic), an always-present
 * non-diagnostic disclaimer, and an emergency / red-flag escalation banner.
 *
 * Design: **retrieve-then-read**, not tool-gated. For a health-record domain we
 * always want the records, so we retrieve up front (via the injected `runSearch`,
 * the same `search_graph` backend the council uses) and ground the model on them —
 * this is robust regardless of how reliably the specialized model emits a native
 * tool call. `runSearch` is injected so it can target a dedicated `health-records`
 * RAG workspace and stay co-located with the (private, on-device) graph.
 */
import { completion } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import type { Hit } from "@mycelium/senses";
import { verifyClaims, type Verdict } from "./critic.ts";
import {
  EMERGENCY_BANNER as EMERGENCY_BANNER_VALUE,
  HEALTH_RECORDS_CONSULT_SYSTEM as HEALTH_RECORDS_CONSULT_SYSTEM_VALUE,
  NON_DIAGNOSTIC_DISCLAIMER as NON_DIAGNOSTIC_DISCLAIMER_VALUE,
} from "./prompt.ts";

export { EMERGENCY_BANNER, HEALTH_RECORDS_CONSULT_SYSTEM, NON_DIAGNOSTIC_DISCLAIMER } from "./prompt.ts";

const RED_FLAG_RE =
  /\b(chest pain|short(ness)? of breath|can'?t breathe|trouble breathing|stroke|face droop|slurred speech|suicidal|kill myself|self[- ]?harm|overdose|anaphylaxis|severe bleeding|unconscious|seizure)\b/i;

/** True if the answer already contains a clinician / professional caveat. */
const hasCaveat = (s: string): boolean => /clinician|\bdoctor\b|professional|not a substitute|medical advice/i.test(s);

export interface MedPsyDeps {
  /** A loaded MedPsy/MedGemma model id (the `medpsy` alias). */
  llmModelId: string;
  /** Retrieves the user's health records (search_graph over the `health-records` workspace). */
  runSearch: (query: string, topK: number) => Promise<Hit[]>;
  /** How many record chunks to ground on (default 5). */
  topK?: number;
  audit?: AuditLog;
  /** Optional live token sink for the streamed answer (demo UX). */
  onToken?: (token: string) => void;
}

export interface MedPsyResult {
  answer: string;
  /** The record chunks the answer was grounded on. */
  sources: Hit[];
  /** Whether the answer cites at least one [Source N]. */
  cited: boolean;
  /** The critic's verdict over the answer vs. the sources. */
  verifierVerdict: Verdict;
  /** The final answer guarantees a non-diagnostic disclaimer (always true). */
  disclaimerPresent: boolean;
  /** Whether the disclaimer had to be appended (the model omitted its own caveat). */
  disclaimerAppended: boolean;
  /** Whether the question tripped an emergency / red-flag pattern → escalation banner prepended. */
  redFlag: boolean;
}

/**
 * Run one MedPsy consult: retrieve the user's records, ground + cite, verify, and
 * safety-wrap. `deps.llmModelId` must be a loaded MedPsy/MedGemma model; `deps.runSearch`
 * should target the user's private `health-records` RAG workspace.
 */
export async function runMedPsyConsult({ deps, question }: { deps: MedPsyDeps; question: string }): Promise<MedPsyResult> {
  const redFlag = RED_FLAG_RE.test(question);
  const topK = deps.topK ?? 5;

  // Retrieve-then-read: always ground on the records (co-located, on-device).
  const sources = await deps.runSearch(question, topK);
  const sourceText = sources.length
    ? sources.map((h, i) => `[Source ${i + 1}] ${h.content.replace(/\s+/g, " ").trim()}`).join("\n")
    : "(no matching records were found)";

  const run = completion({
    modelId: deps.llmModelId,
    history: [
      { role: "system", content: HEALTH_RECORDS_CONSULT_SYSTEM_VALUE },
      { role: "user", content: `SOURCES (the user's health records):\n${sourceText}\n\nQuestion: ${question}\n\nAnswer using only the records above, and cite each claim as [Source N].` },
    ],
    stream: true,
    generationParams: { predict: 512, reasoning_budget: 0 },
  });
  let raw = "";
  for await (const t of run.tokenStream) {
    raw += t;
    deps.onToken?.(t);
  }
  const final = await run.final;
  raw = raw.trim();
  deps.audit?.record({
    event: "completion",
    modelId: deps.llmModelId,
    tokens: final.stats?.generatedTokens,
    extra: { role: "health-records-proposer", sources: sources.length },
  });

  const cited = /\[?source\s*\d/i.test(raw);
  const verifierVerdict = await verifyClaims({ llmModelId: deps.llmModelId, answer: raw, sources, audit: deps.audit });

  const disclaimerAppended = !hasCaveat(raw);
  let answer = disclaimerAppended ? raw + NON_DIAGNOSTIC_DISCLAIMER_VALUE : raw;
  if (redFlag) answer = EMERGENCY_BANNER_VALUE + answer;

  deps.audit?.record({
    event: "note",
    extra: { phase: "health-records", cited, verdict: verifierVerdict.verdict, redFlag, disclaimerAppended, sources: sources.length },
  });

  return { answer, sources, cited, verifierVerdict, disclaimerPresent: true, disclaimerAppended, redFlag };
}
