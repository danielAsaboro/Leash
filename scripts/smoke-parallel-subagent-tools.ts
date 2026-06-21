/**
 * Real QVAC proof that one ToolLoopAgent subagent can emit several independent
 * tool calls in one model step and that the runtime executes the batch concurrently.
 */
import assert from "node:assert/strict";
import { Agent as UndiciAgent, setGlobalDispatcher } from "undici";
import { isStepCount, tool, ToolLoopAgent, type ToolSet } from "ai";
import { z } from "zod";
import { createQvac } from "@mycelium/leash-core/qvac-provider";
import { initialToolBatchInstruction, initialToolPolicyForTask, shouldRequireInitialToolBatch, toolPolicyForStep } from "../apps/web/lib/leash/agent-tool-batching.ts";
import { subagentExecutionPolicy } from "../apps/web/lib/leash/agent-execution-policy.ts";

setGlobalDispatcher(new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 }));

const qvac = createQvac({
  baseURL: process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1",
  apiKey: "qvac",
});
const model = process.env["EVAL_CHAT_MODEL"] ?? "chat";
const DELAY_MS = Number(process.env["LEASH_PARALLEL_TOOL_DELAY_MS"] ?? 700);

interface Window {
  name: string;
  startedAt: number;
  endedAt: number;
}

const windows: Window[] = [];

function recordingTool(name: string, value: string) {
  return tool({
    description: `Read the patient's ${name}. This lookup is independent of the other patient-record lookups.`,
    inputSchema: z.object({ patientId: z.string() }),
    execute: async ({ patientId }) => {
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      const endedAt = Date.now();
      windows.push({ name, startedAt, endedAt });
      return { patientId, [name]: value };
    },
  });
}

const tools = {
  read_vitals: recordingTool("vitals", "BP 128/78; pulse 74"),
  read_allergies: recordingTool("allergies", "penicillin"),
  read_medications: recordingTool("medications", "warfarin 5 mg daily"),
} satisfies ToolSet;
const task = "Review all independent patient record sections together before rounds.";
const initialToolPolicy = initialToolPolicyForTask(task, Object.keys(tools));
const requireInitialToolBatch = shouldRequireInitialToolBatch(task, Object.keys(tools));
assert.equal(requireInitialToolBatch, true, "multi-source read task must require an initial tool batch");
assert.equal(
  initialToolPolicyForTask("Give a short general summary.", Object.keys(tools)),
  "none",
  "ordinary delegated reasoning must not expose irrelevant tools",
);
assert.deepEqual(
  initialToolPolicyForTask(
    "First open the session. Then use its returned token to read private data.",
    ["open_session", "read_private"],
  ),
  { type: "tool", toolName: "open_session" },
  "an explicitly named first operation must be pinned ahead of its dependent tool",
);
assert.equal(toolPolicyForStep("required", 1), "none", "independent batches must not retry tools during synthesis");
assert.equal(
  initialToolPolicyForTask("Use read_vitals and read_allergies to verify the record.", Object.keys(tools)),
  "required",
  "explicitly named independent tools must batch without requiring the literal word both",
);
assert.match(
  initialToolBatchInstruction("Use read_vitals and read_allergies to verify the record.", Object.keys(tools)),
  /read_vitals, read_allergies together/,
  "the delegate receives a concrete one-step batching instruction",
);
assert.equal(subagentExecutionPolicy("summarizer", "Retrieve and summarize the evidence.").reasoning, "none");
assert.equal(subagentExecutionPolicy("coder", "Verify the threshold against the evidence.").reasoning, "none");
assert.equal(subagentExecutionPolicy("coder", "Verify the threshold against the evidence.").maxOutputTokens, 180);
assert.equal(subagentExecutionPolicy("coder", "Debug and fix the TypeScript implementation.").reasoning, "high");

const subagent = new ToolLoopAgent({
  model: qvac(model),
  instructions: [
    "You are a patient-record review subagent.",
    "In your FIRST response, call read_vitals, read_allergies, and read_medications together in the same tool-call step.",
    "The three reads are independent. Do not call them one at a time.",
    "After all results return, give one short factual summary.",
  ].join("\n"),
  tools,
  toolOrder: Object.keys(tools).sort(),
  prepareStep: ({ stepNumber }) => ({
    toolChoice: toolPolicyForStep(initialToolPolicy, stepNumber),
  }),
  stopWhen: isStepCount(3),
  maxRetries: 0,
  maxOutputTokens: 300,
  temperature: 0.2,
  topP: 0.9,
  reasoning: "none",
  providerOptions: { qvac: { reasoning_budget: false } },
});

const startedAt = Date.now();
const result = await subagent.generate({
  prompt: `Patient p-104: ${task} Fetch vitals, allergies, and medications, then summarize.`,
});
const durationMs = Date.now() - startedAt;

const callSteps = result.steps.filter((step) => (step.toolCalls?.length ?? 0) > 0);
const firstBatch = callSteps[0]?.toolCalls ?? [];
const firstBatchNames = firstBatch.map((call) => call.toolName).sort();
const expectedNames = Object.keys(tools).sort();
const observedNames = windows.map((window) => window.name).sort();

console.log(JSON.stringify({
  diagnostic: true,
  steps: result.steps.map((step, index) => ({
    index,
    finishReason: step.finishReason,
    text: step.text.slice(0, 300),
    toolCalls: (step.toolCalls ?? []).map((call) => call.toolName),
    toolResults: (step.toolResults ?? []).map((toolResult) => toolResult.toolName),
  })),
  windows,
}, null, 2));

assert.deepEqual(firstBatchNames, expectedNames, "the first tool-call step must contain all three independent calls");
assert.deepEqual(observedNames, ["allergies", "medications", "vitals"], "all three tools must execute exactly once");

const latestStart = Math.max(...windows.map((window) => window.startedAt));
const earliestEnd = Math.min(...windows.map((window) => window.endedAt));
const batchSpanMs = Math.max(...windows.map((window) => window.endedAt)) - Math.min(...windows.map((window) => window.startedAt));
const sumExecutionMs = windows.reduce((sum, window) => sum + (window.endedAt - window.startedAt), 0);

assert.ok(latestStart < earliestEnd, "all three execution windows must overlap");
assert.ok(batchSpanMs < sumExecutionMs * 0.65, `parallel batch span ${batchSpanMs}ms must be well below serial sum ${sumExecutionMs}ms`);
assert.equal(callSteps.length, 1, "the subagent should batch independent reads into one tool-call step");
assert.ok(result.text.trim().length > 0, "the subagent must synthesize a final answer after the batch");

console.log(JSON.stringify({
  ok: true,
  model,
  durationMs,
  toolCallSteps: callSteps.length,
  firstBatch: firstBatchNames,
  windows,
  batchSpanMs,
  sumExecutionMs,
  finalText: result.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
}, null, 2));
console.log("smoke:parallel-subagent-tools PASS");
