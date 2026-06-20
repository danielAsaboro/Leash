import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mycelium-leash-corpus-"));
const notesDir = join(dir, "notes");
const chatsDir = join(dir, "chats");
mkdirSync(notesDir, { recursive: true });
mkdirSync(chatsDir, { recursive: true });

process.env["LEASH_DATA_DIR"] = dir;
process.env["LEASH_NOTES_DIR"] = notesDir;
process.env["LEASH_CHAT_DIR"] = chatsDir;
process.env["LEASH_ACTIVITY_LOG"] = join(dir, "activity.jsonl");
process.env["LEASH_MEMORIES_FILE"] = join(dir, "memories.json");

writeFileSync(
  join(notesDir, "project.md"),
  "Short.\n\nThis is a durable note about the QVAC RAG upgrade and local retrieval unification across Leash.",
);
writeFileSync(
  process.env["LEASH_ACTIVITY_LOG"],
  [
    JSON.stringify({ ts: "2026-06-20T09:00:00.000Z", app: "Notes", window: "Project", summary: "Reviewing RAG plan", tags: ["rag"] }),
    JSON.stringify({ ts: "2026-06-20T09:05:00.000Z", app: "Browser", window: "Trash", summary: "This should be tombstoned", tags: ["delete"] }),
  ].join("\n"),
);
writeFileSync(join(dir, "leash-activity-tombstones.json"), JSON.stringify({ tombstoned: ["2026-06-20T09:05:00.000Z"] }));
writeFileSync(
  process.env["LEASH_MEMORIES_FILE"],
  JSON.stringify([{ id: "m1", type: "preference", text: "User prefers offline QVAC-only retrieval.", createdAt: "2026-06-20T09:10:00.000Z" }]),
);

const messages = [];
for (let i = 0; i < 70; i++) {
  messages.push({ role: "user", parts: [{ type: "text", text: `question ${i} about private context` }] });
  messages.push({ role: "assistant", parts: [{ type: "text", text: `answer ${i} about retrieval` }] });
}
writeFileSync(join(chatsDir, "chat-a.json"), JSON.stringify({ title: "Retrieval Chat", updatedAt: Date.parse("2026-06-20T09:20:00.000Z"), messages }));

const { collectLeashRagDocs } = await import("../src/graph.ts");
const docs = await collectLeashRagDocs();

assert.ok(docs.some((d) => d.sourceId === "note:project.md:0" && d.kind === "note"), "note paragraph is collected");
assert.ok(docs.some((d) => d.sourceId === "activity:2026-06-20T09:00:00.000Z" && d.kind === "activity"), "live activity is collected");
assert.equal(docs.some((d) => d.sourceId === "activity:2026-06-20T09:05:00.000Z"), false, "tombstoned activity is skipped");
assert.ok(docs.some((d) => d.sourceId === "memory:m1" && d.kind === "memory"), "typed memory is collected");

const chatDocs = docs.filter((d) => d.kind === "chat");
assert.equal(chatDocs.length, 60, "chat collector keeps the newest 60 exchanges per chat");
assert.ok(chatDocs[0]?.content.includes("question 10"), "oldest retained exchange starts at the cap boundary");
assert.ok(chatDocs.at(-1)?.content.includes("question 69"), "newest exchange is retained");

console.log("leash-corpus.test passed");
