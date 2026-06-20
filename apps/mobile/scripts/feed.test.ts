import assert from "node:assert/strict";
import { buildLocalFeedStories } from "../feed";

const stories = buildLocalFeedStories({
  chats: [{ id: "c1", title: "Summarize the QVAC SDK", updatedAt: 10, count: 4 }],
  tasks: [{ id: "t1", title: "Ship the iPad build", status: "in_progress", priority: "high", updatedAt: 20 }],
  notifications: [{ id: "n1", title: "Model downloaded", body: "qwen3 is ready", tier: "notify", read: false, createdAt: 30 }],
});

assert.deepEqual(
  stories.map((s) => s.section),
  ["COMPUTE", "BRIEF", "AI"],
);
assert.equal(stories[0]?.headline, "Model downloaded");
assert.equal(stories[1]?.headline, "Ship the iPad build");
assert.equal(stories[2]?.headline, "Summarize the QVAC SDK");

console.log("feed smoke passed");
