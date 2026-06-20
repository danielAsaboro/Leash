import assert from "node:assert/strict";
import { PRIMARY_TABS, SETTINGS_TAB } from "../tabs";

assert.deepEqual(
  PRIMARY_TABS.map((t) => t.label),
  ["Home", "Chat", "Feed", "Brain", "Activity", "Alerts", "Economy", "Mesh", "Services"],
);
assert.equal(SETTINGS_TAB.label, "Settings");
assert.equal(SETTINGS_TAB.key, "settings");

console.log("tab-parity smoke passed");
