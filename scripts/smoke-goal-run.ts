/**
 * Offline smoke for the durable GoalRun ledger.
 * Run: npm run smoke:goal-run
 */
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = await mkdtemp(join(tmpdir(), "leash-goal-run-"));
process.env["LEASH_DATA_DIR"] = DATA;

const {
  createGoalRun,
  startGoalRunStep,
  updateGoalRunStep,
  recordGoalRunModelTrace,
  recordGoalRunToolTrace,
  finishGoalRun,
  getGoalRun,
  listGoalRuns,
  goalRunView,
} = await import("../packages/leash-core/src/goal-runs.ts");

const run = await createGoalRun({ id: "run-test", chatId: "chat-1", title: "Research, compare, and create tasks", route: "plan", sensitivity: "private" });
assert.equal(run.status, "active");

const s1 = await startGoalRunStep("run-test", { id: "s1", title: "Search private context", route: "plan", model: "qwen3-4b", contextCapsule: "Goal capsule" });
await updateGoalRunStep("run-test", s1.id, { status: "done", summary: "Found three context snippets.", artifact: { kind: "text", title: "Context digest", summary: "3 snippets" } });
const s2 = await startGoalRunStep("run-test", { id: "s2", title: "Create task", route: "plan", model: "qwen3-4b" });
await updateGoalRunStep("run-test", s2.id, { status: "failed", error: "tool said token=supersecret12345678901234567890" });
await recordGoalRunModelTrace("run-test", { stepId: s1.id, model: "qwen3-4b", tokens: 123 });
await recordGoalRunToolTrace("run-test", { stepId: s2.id, toolName: "create_task", route: "plan", ok: false, error: "password=do-not-store" });
await finishGoalRun("run-test", "failed", "Stopped after task creation failed.");

const reloaded = await getGoalRun("run-test");
assert.ok(reloaded, "run reloads from disk");
assert.equal(reloaded!.steps.length, 2);
assert.equal(reloaded!.artifacts.length, 1);
assert.equal(reloaded!.status, "failed");
assert.match(JSON.stringify(reloaded), /redacted-secret/, "secret-looking trace output is redacted");
assert.equal((await listGoalRuns()).length, 1);
assert.equal(goalRunView(reloaded!).steps[0]!.summary, "Found three context snippets.");

await rm(DATA, { recursive: true, force: true });
console.log("smoke:goal-run PASS");
