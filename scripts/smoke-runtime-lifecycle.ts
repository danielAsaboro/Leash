import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = await mkdtemp(join(tmpdir(), "leash-runtime-lifecycle-"));
process.env["LEASH_DATA_DIR"] = dir;
process.env["LEASH_AGENT_LIFECYCLE_FILE"] = join(dir, "lifecycle.jsonl");

const {
  leashRuntimeContextSchema,
  withScopedToolContext,
  toolContextsFor,
  recordAgentLifecycle,
  createLifecycleTimingTransform,
  LEASH_AGENT_TIMEOUT,
} = await import("../apps/web/lib/leash/runtime-lifecycle.ts");

const runtime = leashRuntimeContextSchema.parse({
  requestId: "req-1",
  chatId: "chat-1",
  runId: "run-1",
  stepId: "step-1",
  route: "chat",
  sensitivity: "private",
  startedAt: Date.now(),
});
const tools = withScopedToolContext({
  recall: { description: "read memory", inputSchema: { jsonSchema: { type: "object" } } } as never,
  create_task: { description: "create task", inputSchema: { jsonSchema: { type: "object" } } } as never,
});
const contexts = toolContextsFor(tools, runtime);

assert.deepEqual(Object.keys(contexts).sort(), ["create_task", "recall"]);
assert.equal(contexts.recall?.scope, "memory");
assert.equal(contexts.recall?.risk, "read");
assert.equal(contexts.create_task?.scope, "tasks");
assert.equal(contexts.create_task?.risk, "low_write");
assert.equal(contexts.recall?.chatId, "chat-1");
assert.ok(Object.values(tools).every((definition) => "contextSchema" in definition));
assert.deepEqual(LEASH_AGENT_TIMEOUT, { totalMs: 300_000, stepMs: 180_000, chunkMs: 45_000, toolMs: 30_000 });

recordAgentLifecycle(runtime, { event: "agent_start", callId: "call-1", modelId: "chat" });
recordAgentLifecycle(runtime, { event: "tool_end", callId: "call-1", toolName: "recall", durationMs: 7 });
const timing = createLifecycleTimingTransform(runtime)({ tools: {} });
const writer = timing.writable.getWriter();
await Promise.all([
  (async () => {
    await writer.write({ type: "start" } as never);
    await writer.write({ type: "text-delta", id: "text-1", text: "hello" } as never);
    await writer.close();
  })(),
  timing.readable.pipeTo(new WritableStream()),
]);
const rows = (await readFile(process.env["LEASH_AGENT_LIFECYCLE_FILE"]!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
assert.equal(rows.length, 3);
assert.equal(rows[0].requestId, "req-1");
assert.equal(rows[1].toolName, "recall");
assert.equal(rows[1].durationMs, 7);
assert.equal(rows[2].event, "first_output");
assert.equal(typeof rows[2].ttftMs, "number");

console.log("smoke:runtime-lifecycle PASS");
