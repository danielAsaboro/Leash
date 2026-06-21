import assert from "node:assert/strict";
import { ACTIVITY_TABS, BRAIN_TABS, SETTINGS_TABS } from "../tabSets";

assert.deepEqual(
  BRAIN_TABS.map((t) => t.label),
  ["Memory", "Skills", "Plugins", "Agents", "Tools", "MCP", "Prompts", "Models", "Growth", "Forage", "Proactivity"],
);
assert.deepEqual(
  SETTINGS_TABS.map((t) => t.label),
  ["Account", "Storage", "Devices", "Secrets", "Permissions", "About"],
);
assert.deepEqual(
  ACTIVITY_TABS.map((t) => t.label),
  ["TODOs", "Newsroom", "Runs"],
);

console.log("tab-sets smoke passed");
