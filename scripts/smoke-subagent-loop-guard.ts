import assert from "node:assert/strict";
import { initialToolPolicyForTask, shouldForceSubagentSynthesis, toolNamesForTask } from "../apps/web/lib/leash/agent-tool-batching.ts";

assert.equal(shouldForceSubagentSynthesis([]), false);
assert.equal(
  initialToolPolicyForTask("Judge whether progressive disclosure is safer than exposing every tool.", ["search_graph", "active_context"]),
  "none",
  "pure specialist reasoning must not pay for unrelated private-context tools",
);
assert.deepEqual(
  toolNamesForTask("Judge whether progressive disclosure is safer than exposing every tool.", ["search_graph", "active_context"]),
  [],
  "toolChoice none must also remove every callable schema from the specialist request",
);
assert.equal(
  initialToolPolicyForTask("Search private context for the decision.", ["search_graph", "active_context"]),
  "auto",
  "evidence-seeking specialist work keeps automatic tool selection",
);
assert.equal(
  shouldForceSubagentSynthesis([{ toolResults: [{ output: { content: [{ type: "text", text: "bad args" }], isError: true } }] }]),
  true,
  "a structured tool error must end autonomous tool selection",
);
assert.equal(
  shouldForceSubagentSynthesis([
    { toolCalls: [{ toolName: "search_graph", input: { query: "same" } }] },
    { toolCalls: [{ toolName: "search_graph", input: { query: "same" } }] },
  ]),
  true,
  "an identical repeated tool invocation must end autonomous tool selection",
);
assert.equal(
  shouldForceSubagentSynthesis([
    { toolCalls: [{ toolName: "search_graph", input: { query: "first" } }] },
    { toolCalls: [{ toolName: "search_graph", input: { query: "second" } }] },
  ]),
  false,
  "a deliberate rephrased retrieval remains available",
);

console.log("smoke-subagent-loop-guard: PASS");
