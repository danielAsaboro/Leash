import assert from "node:assert/strict";
import { CHAT_SYSTEM_PROMPT, MOBILE_CHAT_GENERATION_PARAMS, NO_THINK_DIRECTIVE } from "../prompt";

assert.equal(NO_THINK_DIRECTIVE, "/no_think");
assert.equal(MOBILE_CHAT_GENERATION_PARAMS.reasoning_budget, 0);
assert.ok(MOBILE_CHAT_GENERATION_PARAMS.predict > 0);
assert.ok(MOBILE_CHAT_GENERATION_PARAMS.predict <= 256);
assert.ok(CHAT_SYSTEM_PROMPT.length < 800, "phone prompt must stay compact for prompt-evaluation TTFT");

console.log("mobile-generation-policy.test.ts: ok");
