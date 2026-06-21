import assert from "node:assert/strict";

import { z } from "zod";

import type { CapabilityAgent, CapabilityPlugin, CapabilitySkill, CapabilityToolDescriptor } from "../../../packages/capability-runtime/src/index";
import { buildMobileCapabilitySnapshot, resolveMobileCapabilityTurn } from "../lib/capability/runtime-core";

const localSkill: CapabilitySkill = {
  slug: "task-manager",
  name: "task-manager",
  description: "Manage todos.",
  enabled: true,
  body: "Always check tasks before answering.",
  tools: ["list_tasks", "add_task"],
  steps: [],
  examples: ["what is on my list"],
  whenToUse: "tasks, todos, open list",
  builtin: true,
  userInvocable: true,
  disableModelInvocation: false,
  files: [],
  extras: {},
  source: "local",
  pluginId: "",
};

const summaryAgent: CapabilityAgent = {
  slug: "summarizer",
  source: "local",
  pluginId: "",
  name: "Bree",
  description: "Summarize long notes, threads, and documents.",
  body: "You are the summarization specialist.",
  model: "",
  tools: ["list_tasks", "news_search"],
  disallowedTools: [],
  skills: [],
  maxTurns: 4,
  enabled: true,
  builtin: true,
  mcpServers: { refs: [], inline: [] },
  memory: "",
  permissionMode: "",
  hooks: "",
  background: false,
  effort: "",
  isolation: "",
  color: "",
  initialPrompt: "",
};

const plugin: CapabilityPlugin = {
  id: "travel-buddy",
  name: "Travel Buddy",
  enabled: true,
  installedAt: 1,
  skills: [
    {
      slug: "travel-buddy:trip-planner",
      name: "trip-planner",
      description: "Plan trips.",
      enabled: true,
      body: "Use travel tools.",
      tools: ["travel_search"],
      steps: [],
      examples: ["plan a weekend trip"],
      whenToUse: "trip planning",
      builtin: false,
      userInvocable: true,
      disableModelInvocation: false,
      files: [],
      extras: {},
      source: "plugin",
      pluginId: "travel-buddy",
    },
  ],
  agents: [
    {
      slug: "travel-buddy:concierge",
      source: "plugin",
      pluginId: "travel-buddy",
      name: "Concierge",
      description: "Trip and travel planning specialist.",
      body: "You are the travel concierge.",
      model: "",
      tools: ["travel_search"],
      disallowedTools: [],
      skills: ["travel-buddy:trip-planner"],
      maxTurns: 4,
      enabled: true,
      builtin: false,
      mcpServers: { refs: [], inline: [] },
      memory: "",
      permissionMode: "",
      hooks: "",
      background: false,
      effort: "",
      isolation: "",
      color: "",
      initialPrompt: "",
    },
  ],
  mcpServers: [],
};

const toolCatalog: CapabilityToolDescriptor[] = [
  { name: "list_tasks", description: "List tasks." },
  { name: "add_task", description: "Add task.", askFirstDefault: true },
  { name: "travel_search", description: "Search travel options." },
  { name: "news_search", description: "Search current news." },
];

let addTaskCalls = 0;
const toolSet = {
  list_tasks: {
    description: "List tasks.",
    inputSchema: z.object({}),
    execute: async () => ({ tasks: [] }),
  },
  add_task: {
    description: "Add task.",
    inputSchema: z.object({ title: z.string() }),
    execute: async () => {
      addTaskCalls += 1;
      return { ok: true };
    },
  },
  travel_search: {
    description: "Search travel options.",
    inputSchema: z.object({ destination: z.string() }),
    execute: async () => ({ trips: [] }),
  },
  news_search: {
    description: "Search news.",
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ hits: [] }),
  },
};

async function main(): Promise<void> {
  const snapshot = buildMobileCapabilitySnapshot({
    skills: [localSkill],
    agents: [summaryAgent],
    plugins: [plugin],
    mcpServers: [],
    toolCatalog,
    toolState: {
      disabled: ["news_search"],
      askFirst: { add_task: true },
    },
    localTools: toolSet,
    mcpTools: {},
  });

  assert.equal(snapshot.inventory.skills.length, 2, "plugin skills are included");
  assert.equal(snapshot.inventory.agents.length, 2, "plugin agents are included");
  assert.equal(snapshot.inventory.tools.find((row) => row.name === "news_search")?.enabled, false, "disabled tools stay out of the runtime");

  const summaryTurn = await resolveMobileCapabilityTurn(snapshot, {
    query: "summarize my open tasks",
    baseSystem: "Identity: Leash.",
  });

  assert.equal(summaryTurn.skill?.slug, "task-manager", "task skill auto-matches the turn");
  assert.equal(summaryTurn.agent?.slug, "summarizer", "summary agent auto-matches the turn");
  assert.ok(summaryTurn.system.includes("Always check tasks before answering."), "skill body is injected into the turn system");
  assert.ok(summaryTurn.system.includes("You are the summarization specialist."), "agent body is injected into the turn system");
  assert.deepEqual(Object.keys(summaryTurn.tools), ["list_tasks"], "skill and agent tool filters intersect on enabled tools");

  const travelTurn = await resolveMobileCapabilityTurn(snapshot, {
    query: "plan a trip to Accra this weekend",
    baseSystem: "Identity: Leash.",
  });

  assert.equal(travelTurn.skill?.slug, "travel-buddy:trip-planner", "plugin skill can activate locally");
  assert.equal(travelTurn.agent?.slug, "travel-buddy:concierge", "plugin agent can activate locally");
  assert.deepEqual(Object.keys(travelTurn.tools), ["travel_search"], "plugin tool inventory participates in turn filtering");

  const addTaskTurn = await resolveMobileCapabilityTurn(snapshot, {
    query: "add a task to renew the domain",
    baseSystem: "Identity: Leash.",
  });

  await assert.rejects(
    async () => {
      await (addTaskTurn.tools.add_task as unknown as { execute: (input: { title: string }, opts?: unknown) => Promise<unknown> }).execute({ title: "renew the domain" });
    },
    /requires approval in Brain → Tools/i,
    "ask-first tool calls are blocked until approved",
  );
  assert.equal(addTaskCalls, 0, "ask-first wrapper blocks execution");

  console.log("capability-runtime.mobile.test.ts: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
