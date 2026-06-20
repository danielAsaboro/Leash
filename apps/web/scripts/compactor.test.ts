import assert from "node:assert/strict";
import { compactableMessageText } from "../lib/leash/compaction-text.ts";

const assistant = {
  id: "a1",
  role: "assistant",
  parts: [
    { type: "reasoning", text: "private chain of thought that must not return to the agent" },
    { type: "text", text: "Visible answer." },
  ],
};

const user = {
  id: "u1",
  role: "user",
  parts: [
    { type: "reasoning", text: "ignored even if malformed on a user record" },
    { type: "text", text: "User request." },
  ],
};

assert.equal(compactableMessageText(assistant as never), "Visible answer.");
assert.equal(compactableMessageText(user as never), "User request.");

console.log("compactor.test: ok");
