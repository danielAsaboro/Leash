import assert from "node:assert/strict";
import { buildAgentDelegateContextPacket } from "../apps/web/lib/leash/agent-context.ts";
import { buildAgentDelegateContextPrompt } from "../apps/web/lib/leash/prompt.ts";

const packet = buildAgentDelegateContextPacket({
  agent: { slug: "coder", name: "Grace", description: "Coding specialist" },
  task: "Judge the orchestration design.",
  summarySection: "Earlier in this conversation: marker alpha and tool evidence were established.",
  parentContextCapsule: "Current run capsule: answer with agent context intact.",
  currentUserTurn: "Ask Grace to inspect orchestration.",
  selectedTools: ["bash", "search_graph"],
  memoryContext: "Agent memory says keep answers concise.",
  maxChars: 900,
});

assert.match(packet.text, /Agent: Grace \(coder\)/i, "packet names the delegated agent");
assert.match(packet.text, /Judge the orchestration design/i, "packet includes delegated task");
assert.match(packet.text, /marker alpha/i, "packet receives compacted conversation summary");
assert.match(packet.text, /Current run capsule/i, "packet receives current run capsule");
assert.match(packet.text, /Ask Grace/i, "packet receives current user turn");
assert.match(packet.text, /bash, search_graph/i, "packet records selected subagent tools");
assert.match(packet.text, /Agent memory says/i, "packet includes bounded agent memory");
assert.ok(packet.tokenEstimate > 0, "packet reports a token estimate");
assert.equal(packet.truncated, false, "small packet is not truncated");

const tiny = buildAgentDelegateContextPacket({
  agent: { slug: "summarizer", name: "Bree" },
  task: "Summarize.",
  parentContextCapsule: "x ".repeat(2000),
  maxChars: 700,
});
assert.ok(tiny.text.length <= 700, "packet respects maxChars");
assert.equal(tiny.truncated, true, "packet reports truncation");

const prompt = buildAgentDelegateContextPrompt(packet);
assert.match(prompt, /^\/no_think\b/, "subagent context disables unnecessary hidden reasoning");
assert.match(prompt, /Delegate context from Leash/i, "delegate context section is labelled");
assert.match(prompt, /marker alpha/i, "delegate receives compacted conversation summary");
assert.match(prompt, /Current run capsule/i, "delegate receives current run capsule");
assert.match(prompt, /Ask Grace/i, "delegate receives current user turn");
assert.match(prompt, /Leash remains responsible for final synthesis/i, "prompt preserves Leash synthesis ownership");
assert.match(prompt, /Do not repeat the task or narrate your reasoning/i, "prompt requires compact worker output");
assert.equal(buildAgentDelegateContextPrompt(undefined).trim(), "", "empty delegate context produces no prompt section");

console.log("smoke:agent-delegate-context PASS");
