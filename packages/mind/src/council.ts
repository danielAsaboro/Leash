/**
 * The 2-model council (Layer 3 — Mind).
 *
 * Owns the proposer's call/observe/continue loop (≤2 iterations): the proposer is
 * given the `search_graph` tool; when it calls the tool the orchestrator runs the
 * search (injected via `deps.runSearch`, so it can live on whichever device holds
 * the graph), feeds the snippets back as a tool observation, and lets the proposer
 * draft a `[Source N]`-cited answer. The critic (verifier) then checks the answer's
 * claims against the retrieved sources.
 *
 * `runSearch` is injected rather than imported so the same council runs both
 * locally (step 4) and delegated (step 5): the proposer's `completion` runs on the
 * hub via QVAC delegation, while `runSearch` stays co-located with the graph.
 */
import { completion } from "@qvac/sdk";
import type { CompletionFinal, ToolCall } from "@qvac/sdk";
import type { AuditLog } from "@mycelium/shared";
import type { Hit } from "@mycelium/senses";
import { SEARCH_GRAPH_TOOL } from "./tools.ts";
import { verifyClaims, type Verdict } from "./critic.ts";
import { COUNCIL_PROPOSER_SYSTEM } from "./prompt.ts";

type Msg = { role: string; content: string };

export interface CouncilDeps {
  /** Proposer + critic model id (local, or a delegated id pointing at the hub). */
  llmModelId: string;
  /** Runs the `search_graph` tool against the context graph (co-located with the graph). */
  runSearch: (query: string, topK: number) => Promise<Hit[]>;
  audit?: AuditLog;
  /** Optional live token sink for the proposer's streamed output (demo UX). */
  onToken?: (token: string) => void;
}

export type CouncilTraceStep =
  | { step: "propose"; iter: number; toolCalls: string[]; contentPreview: string }
  | { step: "search"; query: string; topK: number; hits: number; topScore: number }
  | { step: "verify"; verdict: Verdict["verdict"] };

export interface CouncilResult {
  answer: string;
  sources: Hit[];
  /** Whether the answer cites at least one [Source N]. */
  cited: boolean;
  verifierVerdict: Verdict;
  trace: CouncilTraceStep[];
}

const MAX_ITERS = 2;

/** One proposer turn with the search_graph tool. Drains the stream (so `final` resolves) and streams via onToken. */
async function proposeTurn(deps: CouncilDeps, history: Msg[]): Promise<CompletionFinal> {
  const run = completion({
    modelId: deps.llmModelId,
    history,
    stream: true,
    tools: [SEARCH_GRAPH_TOOL],
    generationParams: { predict: 512, reasoning_budget: 0 },
  });
  for await (const t of run.tokenStream) deps.onToken?.(t);
  const final = await run.final;
  deps.audit?.record({
    event: "completion",
    modelId: deps.llmModelId,
    tokens: final.stats?.generatedTokens,
    extra: { role: "proposer", toolCalls: final.toolCalls.length },
  });
  return final;
}

function readQuery(args: Record<string, unknown>, fallback: string): string {
  return typeof args["query"] === "string" ? (args["query"] as string) : fallback;
}
function readTopK(args: Record<string, unknown>): number {
  const k = args["topK"];
  return typeof k === "number" ? Math.min(Math.max(1, Math.trunc(k)), 8) : 3;
}

export async function runCouncil({ deps, question }: { deps: CouncilDeps; question: string }): Promise<CouncilResult> {
  const history: Msg[] = [
    { role: "system", content: COUNCIL_PROPOSER_SYSTEM },
    { role: "user", content: question },
  ];
  const sources: Hit[] = [];
  const trace: CouncilTraceStep[] = [];
  let answer = "";

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const final = await proposeTurn(deps, history);
    const searchCalls = final.toolCalls.filter((c: ToolCall) => c.name === SEARCH_GRAPH_TOOL.name);
    trace.push({
      step: "propose",
      iter,
      toolCalls: final.toolCalls.map((c: ToolCall) => c.name),
      contentPreview: final.contentText.replace(/\s+/g, " ").slice(0, 120),
    });
    if (searchCalls.length === 0) {
      answer = final.contentText.trim();
      break;
    }
    // Echo the proposer's tool-call turn, then run each search and feed results back.
    history.push({ role: "assistant", content: final.contentText });
    for (const call of searchCalls) {
      const query = readQuery(call.arguments, question);
      const topK = readTopK(call.arguments);
      const hits = await deps.runSearch(query, topK);
      const base = sources.length;
      sources.push(...hits);
      const context = hits.map((h, i) => `[Source ${base + i + 1}] ${h.content.replace(/\s+/g, " ").trim()}`).join("\n");
      history.push({ role: "tool", content: context });
      trace.push({ step: "search", query, topK, hits: hits.length, topScore: hits[0]?.score ?? 0 });
    }
  }

  // If the proposer kept calling tools up to the cap, force one toolless answer turn.
  if (!answer) {
    history.push({ role: "user", content: "Now answer using only the sources above. Cite each claim as [Source N]." });
    const run = completion({
      modelId: deps.llmModelId,
      history,
      stream: true,
      generationParams: { predict: 512, reasoning_budget: 0 },
    });
    let out = "";
    for await (const t of run.tokenStream) {
      out += t;
      deps.onToken?.(t);
    }
    answer = out.trim();
    deps.audit?.record({ event: "completion", modelId: deps.llmModelId, extra: { role: "proposer-forced" } });
  }

  const cited = /\[?source\s*\d/i.test(answer);
  const verifierVerdict = await verifyClaims({ llmModelId: deps.llmModelId, answer, sources, audit: deps.audit });
  trace.push({ step: "verify", verdict: verifierVerdict.verdict });

  return { answer, sources, cited, verifierVerdict, trace };
}
