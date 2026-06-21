import assert from "node:assert/strict";
import {
  buildFirstDeviceDownloadPlan,
  buildFactoryResetPlan,
  type DownloadPlanRow,
} from "../onboardingPlan";

function rowByKey(rows: DownloadPlanRow[], key: string): DownloadPlanRow {
  const row = rows.find((entry) => entry.key === key);
  assert.ok(row, `missing row ${key}`);
  return row!;
}

const firstDevice = buildFirstDeviceDownloadPlan("qwen3-4b", { deviceLabel: "this iPad" });
assert.equal(firstDevice.defaultExpanded, false, "download disclosure should start collapsed");
assert.equal(firstDevice.rows.length, 4, "first-device setup should disclose chat + support assets");
assert.match(firstDevice.title, /this iPad/i);
assert.match(firstDevice.summary, /4 assets/i);

assert.equal(rowByKey(firstDevice.rows, "chat").timing, "during-setup");
assert.equal(rowByKey(firstDevice.rows, "ocr").timing, "during-setup");
assert.equal(rowByKey(firstDevice.rows, "stt").timing, "during-setup");
assert.equal(rowByKey(firstDevice.rows, "tts").timing, "during-setup");
assert.match(rowByKey(firstDevice.rows, "chat").sizeLabel, /MB|GB/);
assert.match(rowByKey(firstDevice.rows, "chat").purpose, /chat/i);
assert.match(rowByKey(firstDevice.rows, "chat").label, /4B/i);

const reset = buildFactoryResetPlan();
assert.ok(reset.files.some((entry) => entry.key === "device-identity"), "reset should clear device identity");
assert.ok(reset.files.some((entry) => entry.key === "onboarding"), "reset should clear onboarding state");
assert.ok(reset.files.some((entry) => entry.key === "selected-model"), "reset should clear selected chat model");
assert.ok(reset.files.some((entry) => entry.key === "mesh-store"), "reset should clear mesh store");
assert.ok(reset.files.some((entry) => entry.key === "chats"), "reset should clear chats");
assert.ok(reset.secureStoreKeys.length > 0, "reset should clear secure-store secrets");

console.log("onboarding-plan.test.ts: ok");
