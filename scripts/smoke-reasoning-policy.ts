import assert from "node:assert/strict";
import {
  DEEP_OUTPUT_TOKENS,
  DRAFT_OUTPUT_TOKENS,
  normalizeReasoningDraft,
  policyForPlannedMode,
  qvacReasoningProviderOptions,
} from "../apps/web/lib/leash/reasoning-policy.ts";

assert.deepEqual(
  qvacReasoningProviderOptions(false),
  { qvac: { reasoning_budget: false } },
  "direct/draft calls disable QVAC reasoning at inference time",
);

assert.deepEqual(
  policyForPlannedMode("draft", 2_500),
  { mode: "draft", thinkingBudgetTokens: 0, maxOutputTokens: DRAFT_OUTPUT_TOKENS },
  "draft mode disables scratchpad generation and bounds the answer call",
);

assert.equal(
  policyForPlannedMode("deep", 2_500).maxOutputTokens,
  DEEP_OUTPUT_TOKENS,
  "deep mode keeps more headroom but no longer inherits the unbounded tier ceiling",
);

assert.deepEqual(
  normalizeReasoningDraft({
    mode: "draft",
    steps: [
      "one two three four five six seven",
      "second compact step",
      "third step",
      "fourth step",
      "fifth step",
      "sixth step",
      "seventh must be removed",
    ],
    verification: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
  }),
  {
    mode: "draft",
    steps: ["one two three four five", "second compact step", "third step", "fourth step", "fifth step", "sixth step"],
    verification: "one two three four five six seven eight nine ten eleven twelve",
  },
  "overfilled model arguments are normalized to six five-word steps and one bounded check",
);

assert.deepEqual(
  qvacReasoningProviderOptions(true),
  { qvac: { reasoning_budget: true } },
  "deep calls explicitly enable QVAC reasoning",
);

console.log("smoke:reasoning-policy PASS");
