/**
 * Deep research — the plan → search → read → synthesize → stop-check loop, adapted
 * from Odysseus's `src/deep_research.py` (itself after Alibaba Tongyi DeepResearch),
 * rewired onto the local QVAC serve.
 *
 *   npx tsx apps/web/scripts/leash-research.mts <runId> "<question>"
 *
 * Spawned DETACHED by `POST /api/leash/research` (and runnable by hand): the web
 * process stays SDK-free; the run survives Next restarts; the dashboard polls the
 * status file, not the process. Keyless web search (lib/leash/search.ts — DuckDuckGo
 * HTML / optional SearXNG), on-device synthesis via `qvac serve`. This is an ONLINE
 * feature (it needs network), unlike the offline local assistant.
 *
 * Outputs (data/leash-research/):
 *   <runId>.json   throttled status (state, round, queries, sources, progress)
 *   <runId>.md     the final report
 */
import { writeFileSync, renameSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { createQvac } from "@qvac/ai-sdk-provider";
import { Agent, fetch as undiciFetch } from "undici";
import { webSearch, fetchReadable, type SearchResult } from "../lib/leash/search.ts";
import {
  buildResearchExtractPrompt,
  buildResearchFinalReportPrompt,
  buildResearchPlanPrompt,
  buildResearchQueriesPrompt,
  buildResearchStopCheckPrompt,
  buildResearchUpdatePrompt,
} from "../lib/leash/prompt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const DIR = process.env["LEASH_RESEARCH_DIR"] ?? join(ROOT, "data", "leash-research");
const TASKS_FILE = process.env["LEASH_TASKS_FILE"] ?? join(ROOT, "data", "leash-tasks.json");
const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const MODEL = process.env["LEASH_RESEARCH_MODEL"] ?? "qwen3-4b";

const MAX_ROUNDS = Number(process.env["LEASH_RESEARCH_ROUNDS"] ?? 4);
const QUERIES_PER_ROUND = 3;
const RESULTS_PER_QUERY = 5;
const PAGES_PER_ROUND = 6; // cap fetch+extract per round
const BODY_TIMEOUT_MS = Number(process.env["LEASH_RESEARCH_TIMEOUT_MS"] ?? "600000");

// Long body timeout — the 4B buffers a long <think> pass (same as dream.mts).
const dispatcher = new Agent({ bodyTimeout: BODY_TIMEOUT_MS, headersTimeout: BODY_TIMEOUT_MS });
const researchFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
// `x-leash-priority: background` lets the leash-broker yield research to interactive
// chat (harmless when QVAC_OPENAI_URL points straight at the serve).
const qvac = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: researchFetch, headers: { "x-leash-priority": "background" } });

const [runId, question] = [process.argv[2], process.argv[3]];

interface Status {
  id: string;
  question: string;
  /** This child's pid — the dashboard's Cancel button SIGTERMs it. */
  pid?: number;
  state: "planning" | "searching" | "reading" | "synthesizing" | "done" | "error";
  round: number;
  maxRounds: number;
  searchProvider?: string;
  queries: string[];
  sources: { title: string; url: string }[];
  note?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

const status: Status = {
  id: runId ?? "",
  question: question ?? "",
  pid: process.pid,
  state: "planning",
  round: 0,
  maxRounds: MAX_ROUNDS,
  queries: [],
  sources: [],
  startedAt: Date.now(),
  updatedAt: Date.now(),
};

function save(patch: Partial<Status> = {}): void {
  Object.assign(status, patch, { updatedAt: Date.now() });
  mkdirSync(DIR, { recursive: true });
  const tmp = join(DIR, `.${runId}.tmp`);
  writeFileSync(tmp, JSON.stringify(status, null, 2));
  renameSync(tmp, join(DIR, `${runId}.json`));
}

function saveReport(md: string): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = join(DIR, `.${runId}.md.tmp`);
  writeFileSync(tmp, md);
  renameSync(tmp, join(DIR, `${runId}.md`));
}

/** A task row in the shared store (mirrors apps/web lib/leash/tasks-store.ts). */
interface TaskRow {
  id: string;
  title: string;
  detail?: string;
  status: string;
  priority: string;
  tags: string[];
  source: string;
  chatIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Drop a `source:"research"` follow-up onto the shared task store so a finished (or failed)
 *  background run lands on the /tasks dashboard instead of vanishing into a file. Lenient read +
 *  atomic tmp/rename (the dream.mts cross-process discipline); best-effort — a task-write failure
 *  must never fail the research run itself. */
function addResearchTask(t: { title: string; detail?: string }): void {
  try {
    let tasks: TaskRow[] = [];
    try {
      const raw = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
      if (Array.isArray(raw)) tasks = raw as TaskRow[];
    } catch {
      /* missing/garbled → start fresh */
    }
    const now = Date.now();
    tasks.push({
      id: `research-${now}`,
      title: t.title.slice(0, 120),
      ...(t.detail ? { detail: t.detail.slice(0, 1000) } : {}),
      status: "open",
      priority: "normal",
      tags: ["research"],
      source: "research",
      chatIds: [],
      createdAt: now,
      updatedAt: now,
    });
    mkdirSync(dirname(TASKS_FILE), { recursive: true });
    const tmp = join(dirname(TASKS_FILE), `.research-task-${now}.tmp`);
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, TASKS_FILE);
    console.log(`📝 task added → ${TASKS_FILE}`);
  } catch (err) {
    console.error("research: could not add task:", err);
  }
}

// ── Cancel (SIGTERM from the dashboard) ────────────────────────────────────────
// The child owns its status file, so it writes its own "cancelled" terminal state.
// WEDGE RULE: if a serve decode is in flight we must NOT die immediately — dropping
// the connection mid-generation wedges the serve's GPU loop machine-wide (the same
// no-abort rule as the chat route). Flag it, let the in-flight call drain (bounded
// by its maxOutputTokens), and exit at the end of that call. Idle phases (web
// fetches, between calls) exit immediately — external sites can't wedge anything.
let cancelled = false;
let inLlmCall = false;

function exitCancelled(): never {
  save({ state: "error", error: "cancelled by user", finishedAt: Date.now() });
  process.exit(143);
}

process.on("SIGTERM", () => {
  cancelled = true;
  if (!inLlmCall) exitCancelled();
  save({ note: (status.note ? status.note + " " : "") + "Cancelling — letting the in-flight model call finish first (dropping it would wedge the serve)…" });
});

// The qvac serve HANGS forever on a chat request carrying NO tools when the model is
// configured tools:true + toolsMode:dynamic (verified 2026-06-05). So every call ships
// one inert tool; `/no_think` + a "do not call tools" nudge keeps the model from
// actually invoking it, and stopWhen(2) lets it answer even if it does.
const inertTools = {
  noop: tool({
    description: "Unused. Do NOT call this — just answer directly in text.",
    inputSchema: z.object({}),
    execute: async () => ({ ignore: true }),
  }),
};

/** One LLM call (drain the stream; the serve only supports streaming completions). */
async function llm(prompt: string, maxOutputTokens = 1200): Promise<string> {
  inLlmCall = true;
  try {
    const result = streamText({ model: qvac(MODEL), prompt: "/no_think\n" + prompt, maxOutputTokens, tools: inertTools, stopWhen: stepCountIs(2) });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  } finally {
    inLlmCall = false;
    // A cancel that arrived mid-decode exits HERE — after the stream drained (wedge rule).
    if (cancelled) exitCancelled();
  }
}

function extractJsonArray(text: string): string[] {
  const start = text.indexOf("[");
  if (start < 0) return [];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1));
        return Array.isArray(v) ? v.map(String) : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

async function main(): Promise<void> {
  if (!runId || !question) {
    console.error("usage: leash-research.mts <runId> <question>");
    process.exit(2);
  }
  save();

  // 1) Plan
  const plan = await llm(buildResearchPlanPrompt(question), 600);
  let subQuestions = extractJsonArray(plan);
  if (subQuestions.length === 0) subQuestions = [question];

  let report = "";
  const allSources = new Map<string, SearchResult>();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // 2) Generate queries for this round
    save({ state: "searching", round });
    const roundInstr =
      round === 1 ? "Cover the breadth of the plan." : "Focus on gaps and unanswered angles in the report so far.";
    const queryText = await llm(buildResearchQueriesPrompt({ question, subQuestions, report, round, queriesPerRound: QUERIES_PER_ROUND, roundInstruction: roundInstr }), 400);
    const queries = extractJsonArray(queryText).slice(0, QUERIES_PER_ROUND);
    if (queries.length === 0) queries.push(question);
    save({ queries });

    // 3) Search
    const roundResults: SearchResult[] = [];
    let provider = status.searchProvider;
    for (const q of queries) {
      const outcome = await webSearch(q, RESULTS_PER_QUERY);
      provider = outcome.provider;
      for (const r of outcome.results) {
        if (!allSources.has(r.url)) {
          allSources.set(r.url, r);
          roundResults.push(r);
        }
      }
      if (outcome.note) save({ note: outcome.note });
    }
    save({ searchProvider: provider, sources: [...allSources.values()].map((s) => ({ title: s.title, url: s.url })) });

    if (roundResults.length === 0 && round === 1) {
      save({ note: (status.note ? status.note + " " : "") + "No web results — the search provider may be rate-limiting." });
    }

    // 4) Read + extract (cap pages/round)
    save({ state: "reading" });
    const findings: string[] = [];
    for (const r of roundResults.slice(0, PAGES_PER_ROUND)) {
      const content = await fetchReadable(r.url, 12_000);
      if (!content) continue;
      const extract = await llm(buildResearchExtractPrompt({ question, url: r.url, title: r.title, content }), 500);
      if (extract && !/^none\b/i.test(extract)) findings.push(`Source: ${r.title} (${r.url})\n${extract}`);
    }

    // 5) Synthesize into the evolving report
    save({ state: "synthesizing" });
    if (findings.length > 0) {
      report = await llm(buildResearchUpdatePrompt({ question, report, findings }), 1600);
      save();
    }

    // 6) Stop-check (skip on the last round)
    if (round < MAX_ROUNDS && report) {
      const stop = await llm(buildResearchStopCheckPrompt({ question, report }), 120);
      if (/^\s*yes\b/i.test(stop)) {
        save({ note: stop.trim().slice(0, 200) });
        break;
      }
    }
  }

  // 7) Final report
  save({ state: "synthesizing" });
  const sourcesList = [...allSources.values()].map((s) => `- [${s.title || s.url}](${s.url})`).join("\n");
  const final = report
    ? await llm(buildResearchFinalReportPrompt({ question, report }), 2200)
    : `# ${question}\n\n_No web evidence could be gathered (the search provider may be rate-limiting, or you are offline). Try again, or set LEASH_SEARXNG_URL to a SearXNG instance._`;

  const md = `# ${question}\n\n${final}\n\n---\n\n## Sources\n\n${sourcesList || "_none_"}\n`;
  saveReport(md);
  save({ state: "done", finishedAt: Date.now() });
  addResearchTask({
    title: `Review research: ${question.slice(0, 80)}`,
    detail: `Deep-research run finished — ${allSources.size} source(s), ${status.round} round(s). Open the report: /research?run=${runId}`,
  });
  console.log(`📑 research ${runId} done — ${allSources.size} sources, ${status.round} round(s)`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  save({ state: "error", error: msg, finishedAt: Date.now() });
  // A genuine failure (user-cancel exits earlier via SIGTERM, so it never reaches here) →
  // surface it so a forgotten background run doesn't die silently.
  addResearchTask({ title: `Research failed: ${(question ?? runId ?? "").slice(0, 80)}`, detail: `The deep-research run errored: ${msg}. Retry it from /research.` });
  console.error("research failed:", err);
  process.exit(1);
});
