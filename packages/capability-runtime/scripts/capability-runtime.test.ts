import assert from "node:assert/strict";

import {
  buildCapabilityInventory,
  mergeToolState,
  parseCapabilityAgentDocument,
  parseCapabilityPluginManifest,
  parseCapabilitySkillDocument,
  parseMobileMcpJson,
  validateMobileMcpServerInput,
  type CapabilityPlugin,
  type CapabilityToolDescriptor,
} from "../src/index.ts";

const skillDoc = `---
name: task-manager
description: Manage the user's todo list.
metadata: |
  {"builtin":true,"examples":["remind me to renew the domain"]}
allowed-tools: tasks_run
when_to_use: |
  add a todo to renew the domain
steps: |
  find related tasks
  create or update the right task
---
Use the user's task list as the source of truth.
`;

const skill = parseCapabilitySkillDocument("task-manager", skillDoc);
assert.ok(skill, "skill document parses");
assert.equal(skill?.name, "task-manager");
assert.equal(skill?.tools[0], "tasks_run");
assert.equal(skill?.examples[0], "remind me to renew the domain");
assert.equal(skill?.steps.length, 2);
assert.equal(skill?.builtin, true);

assert.equal(
  parseCapabilitySkillDocument(
    "broken-skill",
    `---
name: broken-skill
description: Bad skill.
legacy: true
---
nope
`,
  ),
  null,
  "unknown skill keys are rejected",
);

const agentDoc = `---
name: Ruth
description: Research specialist.
model: chat
tools: web_search, mcp:news
skills: deep-research, context-grounding
max-turns: 8
enabled: true
mcpServers: |
  {"news":{"transport":"http","url":"https://example.com/mcp"}}
---
Investigate with citations.
`;

const agent = parseCapabilityAgentDocument("researcher", agentDoc);
assert.ok(agent, "agent document parses");
assert.equal(agent?.name, "Ruth");
assert.equal(agent?.maxTurns, 8);
assert.equal(agent?.skills[1], "context-grounding");
assert.equal(agent?.mcpServers.inline[0]?.transport, "http");

const manifest = parseCapabilityPluginManifest(
  JSON.stringify({
    name: "Travel Buddy",
    version: "1.2.3",
    description: "Trip helpers.",
    mcpServers: {
      flights: {
        type: "http",
        url: "https://travel.example/mcp",
      },
    },
  }),
);
assert.equal(manifest.id, "travel-buddy");
assert.equal(manifest.name, "Travel Buddy");
assert.equal(manifest.version, "1.2.3");
assert.equal(manifest.mcpServers?.flights?.url, "https://travel.example/mcp");

const toolCatalog: CapabilityToolDescriptor[] = [
  { name: "list_tasks", description: "List tasks." },
  { name: "add_task", description: "Create a task.", askFirstDefault: true },
  { name: "news_search", description: "Search the news." },
];

const rows = mergeToolState(toolCatalog, {
  disabled: ["news_search"],
  askFirst: { add_task: false, list_tasks: true },
});
assert.deepEqual(
  rows.map((row) => ({
    name: row.name,
    enabled: row.enabled,
    askFirst: row.askFirst,
  })),
  [
    { name: "add_task", enabled: true, askFirst: false },
    { name: "list_tasks", enabled: true, askFirst: true },
    { name: "news_search", enabled: false, askFirst: false },
  ],
  "tool state merges enabled and ask-first settings",
);

assert.throws(
  () =>
    validateMobileMcpServerInput({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    }),
  /mobile runtime supports only http and sse MCP transports/i,
  "mobile MCP validation rejects stdio",
);

const parsedMcp = parseMobileMcpJson(`{
  "calendar": {
    "type": "http",
    "url": "https://calendar.example/mcp"
  },
  "filesystem": {
    "type": "stdio",
    "command": "npx"
  }
}`);
assert.equal(parsedMcp.ready.length, 1);
assert.equal(parsedMcp.ready[0]?.key, "calendar");
assert.equal(parsedMcp.errors[0]?.key, "filesystem");

const plugin: CapabilityPlugin = {
  id: "travel-buddy",
  name: "Travel Buddy",
  enabled: true,
  version: "1.2.3",
  description: "Trip helpers.",
  installedAt: 123,
  skills: [
    {
      slug: "travel-buddy:trip-planner",
      name: "trip-planner",
      description: "Plan a trip.",
      enabled: true,
      body: "Plan with the available travel tools.",
      tools: ["news_search"],
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
      description: "Travel specialist.",
      body: "Help with travel research.",
      model: "chat",
      tools: ["news_search"],
      disallowedTools: [],
      skills: ["travel-buddy:trip-planner"],
      maxTurns: 4,
      enabled: true,
      builtin: false,
      mcpServers: { refs: ["travel"], inline: [] },
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
  mcpServers: [
    {
      id: "travel",
      name: "Travel MCP",
      transport: "http",
      enabled: true,
      url: "https://travel.example/mcp",
    },
  ],
};

const inventory = buildCapabilityInventory({
  skills: [
    {
      slug: "task-manager",
      name: "task-manager",
      description: "Manage tasks.",
      enabled: true,
      body: "Use tasks.",
      tools: ["list_tasks", "add_task"],
      steps: [],
      examples: [],
      whenToUse: "tasks",
      builtin: false,
      userInvocable: true,
      disableModelInvocation: false,
      files: [],
      extras: {},
      source: "local",
      pluginId: "",
    },
  ],
  agents: [
    {
      slug: "leash",
      source: "local",
      pluginId: "",
      name: "Leash",
      description: "Main assistant.",
      body: "Base assistant.",
      model: "chat",
      tools: [],
      disallowedTools: [],
      skills: [],
      maxTurns: 6,
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
    },
  ],
  plugins: [plugin],
  mcpServers: [],
  toolCatalog,
  toolState: {
    disabled: ["news_search"],
    askFirst: { add_task: false },
  },
});

assert.equal(inventory.skills.length, 2, "plugin skills merge into active inventory");
assert.equal(inventory.agents.length, 2, "plugin agents merge into active inventory");
assert.equal(inventory.mcpServers.length, 1, "plugin MCP servers merge into active inventory");
assert.equal(
  inventory.tools.find((row) => row.name === "news_search")?.enabled,
  false,
  "tool state is applied after plugin inventory merges",
);

console.log("capability-runtime.test.ts: ok");
