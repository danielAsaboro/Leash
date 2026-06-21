/**
 * Statistical real-QVAC gauntlet for multi-tool ToolLoopAgent subagents.
 *
 * Six sustained parent conversations invoke isolated delegates for three
 * turns, compact their bounded continuity context, and continue for two more.
 * Cohorts cover distinct parallel reads, repeated calls to one tool, dependent
 * sequencing, thrown failures, and tool timeouts.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent as UndiciAgent, setGlobalDispatcher } from "undici";
import {
  isStepCount,
  tool,
  ToolLoopAgent,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { createQvac } from "@mycelium/leash-core/qvac-provider";
import { initialToolPolicyForTask, toolPolicyForStep } from "../apps/web/lib/leash/agent-tool-batching.ts";
import { appendAuthoritativeToolEvidence } from "../apps/web/lib/leash/agent-authoritative-results.ts";
import { memoizeToolExecutions } from "../apps/web/lib/leash/agent-tool-idempotency.ts";

setGlobalDispatcher(new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 }));

const qvac = createQvac({
  baseURL: process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1",
  apiKey: "qvac",
});
const model = process.env["EVAL_CHAT_MODEL"] ?? "chat";
const quick = process.env["LEASH_PARALLEL_QUICK"] === "1";
const rawTranscriptMode = process.env["LEASH_PARALLEL_RAW_TRANSCRIPT"] === "1";
const selectedSpec = process.env["LEASH_PARALLEL_SPEC"];
const turnsPerConversation = quick ? 1 : Math.max(1, Math.min(10, Number(process.env["LEASH_PARALLEL_TURNS"] ?? 5)));
const TOOL_DELAY_MS = Number(process.env["LEASH_PARALLEL_TOOL_DELAY_MS"] ?? 350);

type Cohort = "distinct" | "repeated" | "dependent" | "resilience";
type HistoryMode = "fresh" | "growing" | "compacted" | "post_compaction";

interface ExecutionWindow {
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "error" | "timeout";
  output?: unknown;
  error?: string;
}

interface TrialScore {
  selection: boolean;
  arguments: boolean;
  execution: boolean;
  coordination: boolean;
  synthesis: boolean;
}

interface TrialResult {
  conversation: string;
  cohort: Cohort;
  turn: number;
  historyMode: HistoryMode;
  task: string;
  durationMs: number;
  toolCallSteps: string[][];
  windows: ExecutionWindow[];
  finalText: string;
  error?: string;
  score: TrialScore;
}

interface ConversationSpec {
  name: string;
  cohort: Cohort;
}

interface RunInput {
  conversation: string;
  turn: number;
  history: ModelMessage[];
  historyMode: HistoryMode;
  continuity: string;
}

const fullSpecs: ConversationSpec[] = [
  { name: "distinct-a", cohort: "distinct" },
  { name: "distinct-b", cohort: "distinct" },
  { name: "distinct-c", cohort: "distinct" },
  { name: "repeated-a", cohort: "repeated" },
  { name: "dependent-a", cohort: "dependent" },
  { name: "resilience-a", cohort: "resilience" },
];
const specs = selectedSpec
  ? fullSpecs.filter((spec) => spec.name === selectedSpec)
  : quick
  ? [fullSpecs[0]!, fullSpecs[3]!, fullSpecs[4]!, fullSpecs[5]!]
  : fullSpecs;
assert.ok(specs.length > 0, `unknown LEASH_PARALLEL_SPEC: ${selectedSpec}`);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });

function overlap(windows: ExecutionWindow[]): boolean {
  const complete = windows.filter((window) => window.endedAt !== undefined);
  if (complete.length < 2) return false;
  return Math.max(...complete.map((window) => window.startedAt)) < Math.min(...complete.map((window) => window.endedAt!));
}

function exactMultiset(actual: string[], expected: string[]): boolean {
  return [...actual].sort().join("|") === [...expected].sort().join("|");
}

function withRecordedEvidence(summary: string, windows: ExecutionWindow[]): string {
  return appendAuthoritativeToolEvidence(
    summary,
    windows
      .filter((window) => window.status !== "running")
      .map((window) => ({
        toolName: window.name,
        status: window.status === "done" ? "output" as const : "error" as const,
        value: window.status === "done" ? window.output : window.error,
      })),
  );
}

function compactHistory(conversation: string, throughTurn: number, markers: string[]): ModelMessage[] {
  return [
    {
      role: "user",
      content: `Compacted conversation summary for ${conversation}: turns 1-${throughTurn} completed; authoritative result markers were ${markers.join(", ")}. Continue using current tool results as authoritative.`,
    },
    { role: "assistant", content: "Compacted history loaded. I will continue from the supplied summary." },
  ];
}

function agentMessages(input: RunInput, task: string): ModelMessage[] {
  if (rawTranscriptMode) return [...input.history, { role: "user", content: task }];
  return [{ role: "user", content: input.continuity ? `${input.continuity}\n\nCurrent delegated task:\n${task}` : task }];
}

function idempotent(tools: ToolSet): ToolSet {
  return memoizeToolExecutions(tools);
}

function recordedTool(input: {
  name: string;
  marker: string;
  windows: ExecutionWindow[];
  delayMs?: number;
  failure?: "throw";
}) {
  return tool({
    description: `Read independent source ${input.name}. Return its authoritative marker exactly.`,
    inputSchema: z.object({ requestId: z.string() }),
    execute: async ({ requestId }, options) => {
      const window: ExecutionWindow = {
        name: input.name,
        input: { requestId },
        startedAt: Date.now(),
        status: "running",
      };
      input.windows.push(window);
      try {
        await sleep(input.delayMs ?? TOOL_DELAY_MS, options.abortSignal);
        if (input.failure === "throw") throw new Error(`${input.name}_fixture_failure`);
        const output = { requestId, marker: input.marker };
        window.status = "done";
        window.output = output;
        return output;
      } catch (error) {
        window.status = options.abortSignal?.aborted === true ? "timeout" : "error";
        window.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        window.endedAt = Date.now();
      }
    },
  });
}

function stepCalls(result: Awaited<ReturnType<ToolLoopAgent["generate"]>> | undefined): string[][] {
  if (!result) return [];
  return result.steps
    .map((step) => (step.toolCalls ?? []).map((call) => call.toolName))
    .filter((calls) => calls.length > 0);
}

async function runDistinct(input: RunInput): Promise<{ trial: TrialResult; nextHistory: ModelMessage[]; markers: string[] }> {
  const windows: ExecutionWindow[] = [];
  const countPattern = [2, 3, 5, 3, 2];
  const count = countPattern[(input.turn - 1) % countPattern.length]!;
  const names = ["alpha", "beta", "gamma", "delta", "epsilon"].slice(0, count);
  const requestId = `${input.conversation}-t${input.turn}`;
  const markers = names.map((name) => `${name.toUpperCase()}_${requestId.toUpperCase()}`);
  const tools = Object.fromEntries(
    names.map((name, index) => [
      `read_${name}`,
      recordedTool({ name: `read_${name}`, marker: markers[index]!, windows }),
    ]),
  ) as ToolSet;
  const task = `Read all ${count} independent sources together for request ${requestId}: ${names.join(", ")}. Call every listed tool in the first tool step, then copy every authoritative marker into one concise answer.`;
  const initialToolPolicy = initialToolPolicyForTask(task, Object.keys(tools));
  const agent = new ToolLoopAgent({
    model: qvac(model),
    instructions: "You are a local evidence aggregation subagent. Batch independent reads in one step. Copy returned markers exactly; do not invent or omit them.",
    tools: idempotent(tools),
    toolOrder: Object.keys(tools).sort(),
    prepareStep: ({ stepNumber }) => ({ toolChoice: toolPolicyForStep(initialToolPolicy, stepNumber) }),
    stopWhen: isStepCount(3),
    maxRetries: 0,
    maxOutputTokens: 260,
    temperature: 0.1,
    reasoning: "none",
    providerOptions: { qvac: { reasoning_budget: false } },
  });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>> | undefined;
  let error: string | undefined;
  try {
    result = await agent.generate({ messages: agentMessages(input, task) });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const calls = stepCalls(result);
  const first = calls[0] ?? [];
  const expectedTools = names.map((name) => `read_${name}`);
  const actualRequestIds = windows.map((window) => window.input["requestId"]);
  const finalText = withRecordedEvidence(result?.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() ?? "", windows);
  const score: TrialScore = {
    selection: calls.length === 1 && exactMultiset(first, expectedTools),
    arguments: actualRequestIds.length === count && actualRequestIds.every((id) => id === requestId),
    execution: windows.length === count && windows.every((window) => window.status === "done"),
    coordination: overlap(windows),
    synthesis: markers.every((marker) => finalText.includes(marker)),
  };
  const nextHistory = result
    ? [...input.history, { role: "user" as const, content: task }, ...(result.response.messages as ModelMessage[])]
    : input.history;
  return {
    trial: { conversation: input.conversation, cohort: "distinct", turn: input.turn, historyMode: input.historyMode, task, durationMs: Date.now() - started, toolCallSteps: calls, windows, finalText, ...(error ? { error } : {}), score },
    nextHistory,
    markers,
  };
}

async function runRepeated(input: RunInput): Promise<{ trial: TrialResult; nextHistory: ModelMessage[]; markers: string[] }> {
  const windows: ExecutionWindow[] = [];
  const ids = ["north", "south", "west"].map((region) => `${input.conversation}-${input.turn}-${region}`);
  const markers = ids.map((id) => `RECORD_${id.toUpperCase()}`);
  const tools = {
    read_record: tool({
      description: "Read one independent record by its exact record id. May be called several times in the same step.",
      inputSchema: z.object({ recordId: z.string() }),
      execute: async ({ recordId }, options) => {
        const window: ExecutionWindow = { name: "read_record", input: { recordId }, startedAt: Date.now(), status: "running" };
        windows.push(window);
        try {
          await sleep(TOOL_DELAY_MS, options.abortSignal);
          const output = { recordId, marker: `RECORD_${recordId.toUpperCase()}` };
          window.status = "done";
          window.output = output;
          return output;
        } finally {
          window.endedAt = Date.now();
        }
      },
    }),
  } satisfies ToolSet;
  const task = `Read each of these three independent records together in the first tool step: ${ids.join(", ")}. Call read_record once per exact id, then copy all three markers.`;
  const initialToolPolicy = initialToolPolicyForTask(task, Object.keys(tools));
  const agent = new ToolLoopAgent({
    model: qvac(model),
    instructions: "Batch repeated independent calls to the same read tool. Preserve every exact id and marker.",
    tools: idempotent(tools),
    prepareStep: ({ stepNumber }) => ({ toolChoice: toolPolicyForStep(initialToolPolicy, stepNumber) }),
    stopWhen: isStepCount(3),
    maxRetries: 0,
    maxOutputTokens: 260,
    temperature: 0.1,
    reasoning: "none",
    providerOptions: { qvac: { reasoning_budget: false } },
  });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>> | undefined;
  let error: string | undefined;
  try {
    result = await agent.generate({ messages: agentMessages(input, task) });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const calls = stepCalls(result);
  const observedIds = windows.map((window) => String(window.input["recordId"]));
  const finalText = withRecordedEvidence(result?.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() ?? "", windows);
  const score: TrialScore = {
    selection: calls.length === 1 && (calls[0]?.length ?? 0) === 3 && calls[0]!.every((name) => name === "read_record"),
    arguments: exactMultiset(observedIds, ids),
    execution: windows.length === 3 && windows.every((window) => window.status === "done"),
    coordination: overlap(windows),
    synthesis: markers.every((marker) => finalText.includes(marker)),
  };
  const nextHistory = result
    ? [...input.history, { role: "user" as const, content: task }, ...(result.response.messages as ModelMessage[])]
    : input.history;
  return {
    trial: { conversation: input.conversation, cohort: "repeated", turn: input.turn, historyMode: input.historyMode, task, durationMs: Date.now() - started, toolCallSteps: calls, windows, finalText, ...(error ? { error } : {}), score },
    nextHistory,
    markers,
  };
}

async function runDependent(input: RunInput): Promise<{ trial: TrialResult; nextHistory: ModelMessage[]; markers: string[] }> {
  const windows: ExecutionWindow[] = [];
  const requestId = `${input.conversation}-t${input.turn}`;
  const token = `TOKEN_${requestId.toUpperCase()}`;
  const marker = `PRIVATE_${requestId.toUpperCase()}`;
  const tools = {
    open_session: tool({
      description: "Open the requested session and return its token. This must run before read_private.",
      inputSchema: z.object({ requestId: z.string() }),
      execute: async ({ requestId: got }, options) => {
        const window: ExecutionWindow = { name: "open_session", input: { requestId: got }, startedAt: Date.now(), status: "running" };
        windows.push(window);
        await sleep(TOOL_DELAY_MS, options.abortSignal);
        window.status = "done";
        window.output = { token };
        window.endedAt = Date.now();
        return { token };
      },
    }),
    read_private: tool({
      description: "Read private data using the exact token returned by open_session. Never guess the token.",
      inputSchema: z.object({ token: z.string() }),
      execute: async ({ token: got }, options) => {
        const window: ExecutionWindow = { name: "read_private", input: { token: got }, startedAt: Date.now(), status: "running" };
        windows.push(window);
        await sleep(TOOL_DELAY_MS, options.abortSignal);
        if (got !== token) throw new Error("invalid_session_token");
        window.status = "done";
        window.output = { marker };
        window.endedAt = Date.now();
        return { marker };
      },
    }),
  } satisfies ToolSet;
  const task = `For request ${requestId}, first open the session. Then use the returned token to read private data. Never run the calls concurrently. Copy the final marker.`;
  const initialToolPolicy = initialToolPolicyForTask(task, Object.keys(tools));
  const agent = new ToolLoopAgent({
    model: qvac(model),
    instructions: "Respect data dependencies. Never call a dependent tool until its exact input exists in an earlier tool result.",
    tools: idempotent(tools),
    prepareStep: ({ stepNumber }) => ({ toolChoice: toolPolicyForStep(initialToolPolicy, stepNumber) }),
    stopWhen: isStepCount(4),
    maxRetries: 0,
    maxOutputTokens: 260,
    temperature: 0.1,
    reasoning: "none",
    providerOptions: { qvac: { reasoning_budget: false } },
  });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>> | undefined;
  let error: string | undefined;
  try {
    result = await agent.generate({ messages: agentMessages(input, task) });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const calls = stepCalls(result);
  const session = windows.find((window) => window.name === "open_session");
  const privateRead = windows.find((window) => window.name === "read_private");
  const finalText = withRecordedEvidence(result?.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() ?? "", windows);
  const score: TrialScore = {
    selection: calls.length === 2 && calls[0]?.[0] === "open_session" && calls[1]?.[0] === "read_private",
    arguments: session?.input["requestId"] === requestId && privateRead?.input["token"] === token,
    execution: windows.length === 2 && windows.every((window) => window.status === "done"),
    coordination: !!session?.endedAt && !!privateRead && privateRead.startedAt >= session.endedAt,
    synthesis: finalText.includes(marker),
  };
  const nextHistory = result
    ? [...input.history, { role: "user" as const, content: task }, ...(result.response.messages as ModelMessage[])]
    : input.history;
  return {
    trial: { conversation: input.conversation, cohort: "dependent", turn: input.turn, historyMode: input.historyMode, task, durationMs: Date.now() - started, toolCallSteps: calls, windows, finalText, ...(error ? { error } : {}), score },
    nextHistory,
    markers: [marker],
  };
}

async function runResilience(input: RunInput): Promise<{ trial: TrialResult; nextHistory: ModelMessage[]; markers: string[] }> {
  const windows: ExecutionWindow[] = [];
  const requestId = `${input.conversation}-t${input.turn}`;
  const timeoutTrial = input.turn % 2 === 0;
  const markers = [`GOOD_A_${requestId.toUpperCase()}`, `GOOD_B_${requestId.toUpperCase()}`];
  const tools = {
    read_good_a: recordedTool({ name: "read_good_a", marker: markers[0]!, windows }),
    read_good_b: recordedTool({ name: "read_good_b", marker: markers[1]!, windows }),
    [timeoutTrial ? "read_slow" : "read_broken"]: recordedTool({
      name: timeoutTrial ? "read_slow" : "read_broken",
      marker: "SHOULD_NOT_APPEAR",
      windows,
      ...(timeoutTrial ? { delayMs: TOOL_DELAY_MS * 5 } : { failure: "throw" as const }),
    }),
  } as ToolSet;
  const failingName = timeoutTrial ? "read_slow" : "read_broken";
  const task = `Read all three independent sources together for request ${requestId}. Preserve the two good markers and explicitly report that ${failingName} was unavailable; do not invent its value.`;
  const initialToolPolicy = initialToolPolicyForTask(task, Object.keys(tools));
  const agent = new ToolLoopAgent({
    model: qvac(model),
    instructions: "Batch independent reads. Treat tool errors and timeouts as authoritative unavailable results; preserve successful evidence and never invent missing data.",
    tools: idempotent(tools),
    toolOrder: Object.keys(tools).sort(),
    prepareStep: ({ stepNumber }) => ({ toolChoice: toolPolicyForStep(initialToolPolicy, stepNumber) }),
    stopWhen: isStepCount(3),
    maxRetries: 0,
    maxOutputTokens: 280,
    temperature: 0.1,
    reasoning: "none",
    providerOptions: { qvac: { reasoning_budget: false } },
  });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>> | undefined;
  let error: string | undefined;
  try {
    result = await agent.generate({
      messages: agentMessages(input, task),
      ...(timeoutTrial ? { timeout: { tools: { read_slowMs: Math.max(50, Math.floor(TOOL_DELAY_MS / 2)) } } } : {}),
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  // A timed-out executor receives its abort asynchronously; give the fixture a
  // brief chance to record its terminal state before scoring.
  await sleep(25);
  const calls = stepCalls(result);
  const finalText = withRecordedEvidence(result?.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() ?? "", windows);
  const failedWindow = windows.find((window) => window.name === failingName);
  const goodWindows = windows.filter((window) => window.name.startsWith("read_good"));
  const expectedTools = ["read_good_a", "read_good_b", failingName];
  const score: TrialScore = {
    selection: exactMultiset(calls[0] ?? windows.map((window) => window.name), expectedTools),
    arguments: windows.length === 3 && windows.every((window) => window.input["requestId"] === requestId),
    execution:
      goodWindows.length === 2 &&
      goodWindows.every((window) => window.status === "done") &&
      failedWindow?.status === (timeoutTrial ? "timeout" : "error"),
    coordination: overlap(windows),
    synthesis:
      markers.every((marker) => finalText.includes(marker)) &&
      /unavailable|failed|timeout|timed out|error/i.test(finalText) &&
      !finalText.includes("SHOULD_NOT_APPEAR"),
  };
  const nextHistory = result
    ? [...input.history, { role: "user" as const, content: task }, ...(result.response.messages as ModelMessage[])]
    : input.history;
  return {
    trial: { conversation: input.conversation, cohort: "resilience", turn: input.turn, historyMode: input.historyMode, task, durationMs: Date.now() - started, toolCallSteps: calls, windows, finalText, ...(error ? { error } : {}), score },
    nextHistory,
    markers,
  };
}

function historyMode(turn: number): HistoryMode {
  if (turn === 1) return "fresh";
  if (turn <= 3) return "growing";
  if (turn === 4) return "compacted";
  return "post_compaction";
}

const trials: TrialResult[] = [];
for (const spec of specs) {
  let history: ModelMessage[] = [];
  const priorMarkers: string[] = [];
  console.error(`\n[${spec.name} · ${spec.cohort}]`);
  for (let turn = 1; turn <= turnsPerConversation; turn++) {
    const mode = historyMode(turn);
    const runner =
      spec.cohort === "distinct"
        ? runDistinct
        : spec.cohort === "repeated"
          ? runRepeated
          : spec.cohort === "dependent"
            ? runDependent
            : runResilience;
    const continuity = priorMarkers.length
      ? `${mode === "compacted" || mode === "post_compaction" ? "Compacted" : "Bounded"} parent context for ${spec.name}: prior turns completed with ${priorMarkers.join(", ")}. These are historical only; execute the current delegated task and use its current tool results.`
      : "";
    const outcome = await runner({ conversation: spec.name, turn, history, historyMode: mode, continuity });
    trials.push(outcome.trial);
    history = outcome.nextHistory;
    priorMarkers.push(...outcome.markers);
    const passed = Object.values(outcome.trial.score).filter(Boolean).length;
    console.error(
      `turn ${turn}/${turnsPerConversation} ${mode} · ${passed}/5 · ${outcome.trial.durationMs}ms` +
        (outcome.trial.error ? ` · ${outcome.trial.error.slice(0, 100)}` : ""),
    );
    if (!quick && turn === 3) history = compactHistory(spec.name, turn, priorMarkers);
  }
}

const dimensions = ["selection", "arguments", "execution", "coordination", "synthesis"] as const;
const accuracy = Object.fromEntries(
  dimensions.map((dimension) => {
    const passed = trials.filter((trial) => trial.score[dimension]).length;
    return [dimension, { passed, total: trials.length, rate: passed / trials.length }];
  }),
);
const fullyCorrect = trials.filter((trial) => Object.values(trial.score).every(Boolean)).length;
const durations = trials.map((trial) => trial.durationMs).sort((a, b) => a - b);
const percentile = (p: number): number => durations[Math.floor((durations.length - 1) * p)] ?? 0;
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model,
  quick,
  rawTranscriptMode,
  selectedSpec: selectedSpec ?? null,
  conversations: specs.length,
  turnsPerConversation,
  trials: trials.length,
  fullyCorrect: { passed: fullyCorrect, total: trials.length, rate: fullyCorrect / trials.length },
  accuracy,
  latencyMs: {
    min: durations[0] ?? 0,
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: durations.at(-1) ?? 0,
  },
};

const logsDir = join(process.cwd(), "logs");
await mkdir(logsDir, { recursive: true });
const reportPath = join(logsDir, `parallel-subagent-gauntlet-${Date.now().toString(36)}.json`);
await writeFile(reportPath, `${JSON.stringify({ summary, trials }, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, reportPath }, null, 2));

if (selectedSpec) {
  assert.equal(trials.length, turnsPerConversation, "selected conversation must complete every configured turn");
} else if (quick) {
  assert.equal(trials.length, 4, "quick gauntlet must exercise all four cohorts");
} else {
  assert.ok(trials.length >= 30, "full gauntlet must run at least 30 real trials");
}

const minimumRate = Number(process.env["LEASH_PARALLEL_MIN_ACCURACY"] ?? 0.9);
assert.ok(
  (accuracy.selection?.rate ?? 0) >= minimumRate &&
    (accuracy.arguments?.rate ?? 0) >= minimumRate &&
    (accuracy.execution?.rate ?? 0) >= minimumRate &&
    (accuracy.coordination?.rate ?? 0) >= minimumRate,
  `core multi-tool accuracy fell below ${(minimumRate * 100).toFixed(0)}%; see ${reportPath}`,
);
console.log("stress:parallel-subagent-tools PASS");
