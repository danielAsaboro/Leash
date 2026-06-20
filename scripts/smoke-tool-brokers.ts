import assert from "node:assert/strict";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { buildCapabilityBrokers, BROKER_TOOL_NAMES } from "../apps/web/lib/leash/tool-brokers.ts";
import { resolveActiveToolNames } from "../apps/web/lib/leash/tool-exposure.ts";

const calls: Array<{ name: string; args: unknown }> = [];
const registry: ToolSet = {
  bash: tool({
    description: "raw bash",
    inputSchema: z.object({ command: z.string() }),
    execute: async (args) => {
      calls.push({ name: "bash", args });
      return { text: "bash output" };
    },
  }),
  recall: tool({
    description: "raw recall",
    inputSchema: z.object({ query: z.string() }),
    execute: async (args) => {
      calls.push({ name: "recall", args });
      return { text: "memory output", sources: [{ kind: "memory", title: "m", snippet: "s" }] };
    },
  }),
  create_task: tool({
    description: "raw create task",
    inputSchema: z.object({ title: z.string() }),
    execute: async (args) => {
      calls.push({ name: "create_task", args });
      return { text: "task created" };
    },
  }),
  search_graph: tool({
    description: "raw graph search",
    inputSchema: z.object({ query: z.string() }),
    execute: async (args) => {
      calls.push({ name: "search_graph", args });
      return { text: "graph hit" };
    },
  }),
};

const brokers = buildCapabilityBrokers(registry);
assert.deepEqual(Object.keys(brokers).sort(), ["context_run", "files_run", "memory_run", "tasks_run"], "only live capability brokers are created");
assert.ok(BROKER_TOOL_NAMES.has("files_run"), "broker names are exported for exposure filtering");

const files = brokers["files_run"] as { execute: (args: unknown, opts?: unknown) => Promise<unknown> };
const filesOut = await files.execute({ action: "bash", input: { command: "date" } }, {});
assert.deepEqual(calls.at(-1), { name: "bash", args: { command: "date" } }, "files broker dispatches to raw bash");
assert.equal((filesOut as { text?: string }).text, "bash output", "broker returns normalized text");

const memory = brokers["memory_run"] as { execute: (args: unknown, opts?: unknown) => Promise<unknown> };
const memoryOut = await memory.execute({ action: "recall", input: { query: "launch" } }, {});
assert.deepEqual(calls.at(-1), { name: "recall", args: { query: "launch" } }, "memory broker dispatches selected action");
assert.equal(Array.isArray((memoryOut as { sources?: unknown[] }).sources), true, "broker preserves structured fields");

const activeChat = resolveActiveToolNames(
  ["bash", "recall", "create_task", "search_graph", "files_run", "memory_run", "tasks_run", "context_run"],
  { route: "chat" },
);
assert.deepEqual(activeChat.sort(), ["context_run", "files_run", "memory_run", "tasks_run"], "default chat sees brokers, not raw grouped tools");
assert.deepEqual(resolveActiveToolNames(["bash", "files_run"], { route: "files" }), ["bash"], "files route keeps raw bash");
assert.deepEqual(resolveActiveToolNames(["recall", "context_run"], { route: "health" }), ["recall"], "health route keeps raw health tools");
assert.deepEqual(resolveActiveToolNames(["bash", "run_skill", "files_run"], { route: "chat", skillTools: ["bash"] }), ["bash", "run_skill"], "skill tools keep declared raw tools");

console.log("✅ tool brokers — grouped schemas compress chat without removing raw lane executors");
