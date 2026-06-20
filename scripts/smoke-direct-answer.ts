import assert from "node:assert/strict";
import { directBashCommandForSimpleTurn } from "../apps/web/lib/leash/bash-command-fast-path.ts";
import { directBrokerCallForSimpleTurn } from "../apps/web/lib/leash/broker-fast-path.ts";
import { directAnswerForSimpleTurn, directAnswerForSkillMetadataTurn, localInferenceUnavailableAnswer } from "../apps/web/lib/leash/direct-answer.ts";
import { directHealthSafetyCallForSimpleTurn } from "../apps/web/lib/leash/health-fast-path.ts";

assert.equal(directAnswerForSimpleTurn("hi"), "Hi.", "greeting answers directly");
assert.equal(directAnswerForSimpleTurn("Turn marker: 1. Answer directly: marker 1 starts the run. Do not mention tools."), "Marker 1 starts the run.", "start marker answers directly");
assert.equal(directAnswerForSimpleTurn("Turn marker: 9. Answer one compact sentence: marker 9 followed marker 8."), "Marker 9 followed marker 8.", "continuity marker answers directly");
assert.equal(directAnswerForSimpleTurn("Turn marker: 12. Answer directly: marker 12 follows the broker and files checks. No search needed."), "Marker 12 follows the broker and files checks.", "post-tool marker answers directly");
assert.equal(directAnswerForSimpleTurn("Use the sandboxed bash tool to run date"), null, "tool requests are not direct answered");
assert.equal(directAnswerForSimpleTurn("search my files for qvac"), null, "retrieval requests are not direct answered");

assert.equal(
  directAnswerForSkillMetadataTurn("Use the file-finder skill context only. Do not search files. Say which tool that skill uses for local file search."),
  "The file-finder skill uses the sandboxed bash tool for local file search.",
  "file-finder metadata answers directly",
);
assert.equal(directBashCommandForSimpleTurn("Use the sandboxed bash tool to run date, then answer with the date output only."), "date", "simple date command takes bash fast path");
assert.equal(directBashCommandForSimpleTurn("Use bash to run rm -rf /"), null, "unsafe arbitrary shell command is not parsed");
assert.deepEqual(
  directBrokerCallForSimpleTurn("Use context-grounding. Search my private context for Leash tool broker or context bloat notes, then answer with one grounded sentence."),
  { broker: "context_run", action: "search_graph", input: { query: "Leash tool broker context bloat notes", topK: 3 } },
  "context broker prompt maps to search_graph",
);
assert.deepEqual(
  directBrokerCallForSimpleTurn("Use memory-keeper recall only. Recall any durable memory about preferred answer length, then answer compactly."),
  { broker: "memory_run", action: "recall", input: { type: "preference", query: "preferred answer length" } },
  "memory broker prompt maps to recall",
);
assert.deepEqual(
  directBrokerCallForSimpleTurn("Use task-manager. List open tasks only; do not create or update tasks. Summarize the count or say none are available."),
  { broker: "tasks_run", action: "list_tasks", input: { status: "open" } },
  "tasks broker prompt maps to list_tasks",
);
assert.deepEqual(
  directBrokerCallForSimpleTurn("Use daily-paper. Check today's Understory edition or recent paper context and give one sentence."),
  { broker: "context_run", action: "understory_today", input: {} },
  "daily-paper prompt maps to understory_today",
);
assert.deepEqual(
  directHealthSafetyCallForSimpleTurn("Health-safety check: based on my private records if available, what should I ask a clinician about blood pressure meds? Keep it non-diagnostic."),
  { kind: "blood_pressure_meds_clinician" },
  "health safety prompt maps to direct read-only health check",
);
assert.match(
  localInferenceUnavailableAnswer("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11435"),
  /local QVAC inference is unavailable.*did not send.*cloud/i,
  "local inference failure response is explicit and cloud-free",
);

console.log("smoke:direct-answer PASS");
