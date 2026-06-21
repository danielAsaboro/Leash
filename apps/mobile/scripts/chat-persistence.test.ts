import assert from "node:assert/strict";
import { chatNeedsSave, snapshotChat } from "../chat-persistence.ts";
import type { StoredMessage } from "../chats.ts";

const stored: StoredMessage[] = [
  { id: "u1", role: "user", content: "Existing question" },
  { id: "a1", role: "assistant", content: "Existing answer" },
];

const loaded = snapshotChat("chat-a", stored);
assert.equal(chatNeedsSave(loaded, "chat-a", [...stored]), false, "opening a chat is read-only");
assert.equal(chatNeedsSave(loaded, "chat-b", [...stored]), true, "snapshots are scoped to their chat id");

const edited = [...stored, { id: "u2", role: "user" as const, content: "A real new turn" }];
assert.equal(chatNeedsSave(loaded, "chat-a", edited), true, "a real message change is persisted");
assert.equal(chatNeedsSave(null, "chat-new", []), false, "an untouched new chat is not persisted");

console.log("mobile chat persistence: opening is read-only; real edits remain writable");
