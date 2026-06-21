import assert from "node:assert/strict";
import { chatMessagesChanged } from "../lib/leash/chat-persistence.ts";

const messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];
assert.equal(chatMessagesChanged(messages, structuredClone(messages)), false, "opening/hydrating identical chat is not an update");
assert.equal(chatMessagesChanged(messages, [...messages, { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] }]), true, "new content is meaningful");
assert.equal(chatMessagesChanged(messages, [{ ...messages[0], parts: [{ type: "text", text: "edited" }] }]), true, "edit is meaningful");
console.log("✅ web chat persistence — idempotent reopen preserves updatedAt; content changes update");
