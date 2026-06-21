import assert from "node:assert/strict";
import { resolveActiveToolNames, SKILL_TOOLS_CAP } from "../apps/web/lib/leash/tool-exposure.ts";

const allNames = [
  "leash_keepalive",
  "bash",
  "search_graph",
  "active_context",
  "activity_recent",
  "remember",
  "recall",
  "create_task",
  "list_tasks",
  "update_task",
  "files_run",
  "memory_run",
  "tasks_run",
  "context_run",
  "mcp_run",
  "install_mcp_repo",
  "upsert_mcp_server",
  "read_skill",
  "read_skill_file",
  "run_skill_script",
  "run_skill",
  "agent__coder",
  "agent__summarizer",
  "list_apps",
  "get_app_state",
  "click",
  "scroll",
  "press_key",
  "ha_list_entities",
  "search-notes",
  "get-note-content",
  "resolve-library-id",
  "get-library-docs",
];

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "chat", leanTools: true }),
  ["leash_keepalive"],
  "lean chat exposes only keepalive",
);

assert.deepEqual(resolveActiveToolNames(allNames, { route: "files" }), ["bash"], "files route exposes only bash");

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "computer" }),
  ["list_apps", "get_app_state", "click", "scroll", "press_key"],
  "computer route exposes only computer tools",
);

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "health" }),
  ["search_graph", "active_context", "activity_recent", "recall"],
  "health route exposes only health read tools",
);

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "chat" }),
  [
    "files_run",
    "memory_run",
    "tasks_run",
    "context_run",
    "read_skill",
    "read_skill_file",
    "run_skill_script",
    "run_skill",
  ],
  "default chat exposes brokers and skill-system tools, not raw grouped, external MCP, or subagent tools",
);

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "chat", agentTools: ["agent__coder"] }),
  [
    "files_run",
    "memory_run",
    "tasks_run",
    "context_run",
    "read_skill",
    "read_skill_file",
    "run_skill_script",
    "run_skill",
    "agent__coder",
  ],
  "chat exposes only the selected subagent tools for this turn",
);

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "chat", agentTools: ["agent__coder"], suppressRunSkill: true }),
  [
    "files_run",
    "memory_run",
    "tasks_run",
    "context_run",
    "read_skill",
    "read_skill_file",
    "run_skill_script",
    "agent__coder",
  ],
  "agent-delegation turns suppress run_skill so agents are not called through the skill runner",
);

assert.deepEqual(
  resolveActiveToolNames(allNames, { route: "chat", skillTools: ["bash"] }),
  ["bash", "read_skill", "read_skill_file", "run_skill_script", "run_skill"],
  "active skill gets declared tools plus skill system tools",
);

const manySkillTools = Array.from({ length: 30 }, (_, i) => `skill_tool_${i}`);
assert.equal(
  resolveActiveToolNames([...manySkillTools], { route: "chat", skillTools: manySkillTools }).length,
  SKILL_TOOLS_CAP,
  "skill tool exposure is capped",
);

console.log("smoke:tool-exposure PASS");
