import assert from "node:assert/strict";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { planExplicitAgentTasks, planMandatedReadCalls } from "../apps/web/lib/leash/agent-explicit-plan.ts";

const selected = [
  { slug: "coder", name: "Grace", toolName: "agent__coder", reason: "explicit" as const },
  { slug: "summarizer", name: "Bree", toolName: "agent__summarizer", reason: "explicit" as const },
];
const prompt = [
  "Coordinate both Grace and Bree.",
  "Delegate Grace a separate task to use search_graph and active_context to verify the image evidence and evaluate the threshold.",
  "Delegate Bree a separate task to use search_graph and active_context to summarize the same evidence without inventing facts.",
  "After both return, produce one grounded synthesis.",
].join(" ");
const plans = planExplicitAgentTasks(prompt, selected, ["search_graph", "active_context", "create_task"]);
assert.ok(plans, "explicit independent delegations should produce a deterministic plan");
assert.equal(plans.length, 2);
assert.deepEqual(plans[0]?.mandatedTools, ["search_graph", "active_context"]);
assert.deepEqual(plans[1]?.mandatedTools, ["search_graph", "active_context"]);
assert.match(plans[0]?.task ?? "", /verify the image evidence/i);
assert.match(plans[1]?.task ?? "", /without inventing facts/i);

assert.equal(
  planExplicitAgentTasks("Ask Grace and Bree to work this out together.", selected, ["search_graph"]),
  null,
  "an ambiguous shared task must fall back to model-planned orchestration",
);

const registry: ToolSet = {
  search_graph: tool({ inputSchema: z.object({ query: z.string(), topK: z.number().optional() }), execute: async () => ({ text: "evidence" }) }),
  active_context: tool({ inputSchema: z.object({}), execute: async () => ({ text: "activity" }) }),
  create_task: tool({ inputSchema: z.object({ title: z.string() }), execute: async () => ({ ok: true }) }),
};
const reads = planMandatedReadCalls(prompt, ["search_graph", "active_context"], registry);
assert.ok(reads, "known approval-free reads should be pre-executable");
assert.deepEqual(reads.map((entry) => entry.input), [{ query: prompt, topK: 3 }, {}]);
assert.equal(planMandatedReadCalls(prompt, ["create_task"], registry), null, "write tools must never enter the read fast path");

console.log("smoke:explicit-agent-plan PASS");
