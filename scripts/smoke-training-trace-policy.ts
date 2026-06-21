import assert from "node:assert/strict";
import { normalizeReasoningFeedback } from "../apps/web/lib/leash/feedback-policy.ts";
import { AUTOMATIC_TRAINING_SOURCES } from "../packages/memory/src/curate.ts";

assert.deepEqual(AUTOMATIC_TRAINING_SOURCES, ["feedback", "council", "memory", "graph"]);
assert.ok(!AUTOMATIC_TRAINING_SOURCES.includes("chat" as never), "unreviewed chats must not train");
assert.deepEqual(
  normalizeReasoningFeedback({ mode: "draft", totalTokens: 528, draftTokens: 78, draftMs: 5285, responseMs: 28071, hiddenReasoning: "never persist me" }),
  { mode: "draft", totalTokens: 528, draftTokens: 78, draftMs: 5285, responseMs: 28071 },
);
assert.equal(normalizeReasoningFeedback({ mode: "unknown", totalTokens: -1, draftMs: Number.NaN }), undefined);

console.log("smoke:training-trace-policy PASS");
