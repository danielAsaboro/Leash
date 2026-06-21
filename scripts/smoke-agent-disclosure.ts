import assert from "node:assert/strict";
import { planAgentDisclosure } from "../apps/web/lib/leash/agent-disclosure.ts";
import type { Agent } from "@mycelium/leash-core/agents-store";

function agent(slug: string, name: string, description: string): Agent {
  return {
    slug,
    source: "user",
    pluginId: "",
    name,
    description,
    body: "",
    model: "",
    tools: [],
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
}

const agents = [
  agent("coder", "Grace", "Coding specialist for writing, debugging, testing, and explaining code and scripts."),
  agent("summarizer", "Bree", "Summarization specialist for long documents, notes, transcripts, papers, and threads."),
  agent("researcher", "Ruth", "Research specialist for multi-source research, source comparison, citations, and investigation."),
  agent("health", "Joy", "Health and wellbeing specialist for medical, symptoms, medication, sleep, nutrition, and therapy questions."),
];

assert.deepEqual(
  planAgentDisclosure("Please ask Grace to inspect this failing TypeScript route.", agents),
  {
    mode: "explicit",
    selected: [{ slug: "coder", name: "Grace", toolName: "agent__coder", reason: "explicit" }],
    suppressRunSkill: true,
    directDelegate: false,
  },
  "explicit named delegate exposes the matching agent",
);

assert.deepEqual(
  planAgentDisclosure("Can Bree summarize this transcript into decisions and action items?", agents),
  {
    mode: "explicit",
    selected: [{ slug: "summarizer", name: "Bree", toolName: "agent__summarizer", reason: "explicit" }],
    suppressRunSkill: true,
    directDelegate: false,
  },
  "simple one-agent delegation still keeps Leash as the synthesizing orchestrator",
);

assert.deepEqual(
  planAgentDisclosure("Can Bree summarize this conversation so far into one paragraph? Demo marker live.", agents),
  {
    mode: "explicit",
    selected: [{ slug: "summarizer", name: "Bree", toolName: "agent__summarizer", reason: "explicit" }],
    suppressRunSkill: true,
    directDelegate: false,
  },
  "live-showcase Bree wording is explicit agent intent",
);

assert.deepEqual(
  planAgentDisclosure("I pasted a stack trace; figure out the bug and propose the smallest code fix.", agents),
  {
    mode: "semantic",
    selected: [{ slug: "coder", name: "Grace", toolName: "agent__coder", reason: "semantic" }],
    suppressRunSkill: true,
    directDelegate: false,
  },
  "high-confidence coding task semantically discloses one coder agent",
);

assert.deepEqual(
  planAgentDisclosure("Think through this and tell me what you recommend.", agents),
  { mode: "none", selected: [], suppressRunSkill: false, directDelegate: false },
  "ambiguous general chat does not expose agent tools",
);

assert.deepEqual(
  planAgentDisclosure("Use the contract-review skill on this clause, then answer.", agents, { activeSkillTools: ["bash"] }),
  { mode: "none", selected: [], suppressRunSkill: false, directDelegate: false },
  "active skill tool lane suppresses agent disclosure",
);

assert.deepEqual(
  planAgentDisclosure("Now delegate to the Bree/summarizer subagent.", agents, { activeSkillTools: ["context_run"] }),
  {
    mode: "explicit",
    selected: [{ slug: "summarizer", name: "Bree", toolName: "agent__summarizer", reason: "explicit" }],
    suppressRunSkill: true,
    directDelegate: false,
  },
  "explicit subagent delegation outranks an automatic active skill lane",
);

console.log("smoke:agent-disclosure PASS");
