import assert from "node:assert/strict";
import { deviceToolNamesForPrompt } from "../lib/agent/tool-routing";

assert.deepEqual(deviceToolNamesForPrompt("Reply exactly: Android ready."), []);
assert.deepEqual(deviceToolNamesForPrompt("What can you do offline?"), []);
assert.deepEqual(deviceToolNamesForPrompt("What time is it?"), ["get_current_time"]);
assert.deepEqual(deviceToolNamesForPrompt("List my tasks and create a note summarizing them"), [
  "list_tasks",
  "add_task",
  "complete_task",
  "delete_task",
  "search_notes",
  "create_note",
]);
assert.deepEqual(deviceToolNamesForPrompt("Remember that I prefer short answers"), ["remember", "list_memories"]);

console.log("mobile-tool-routing.test.ts: ok");
