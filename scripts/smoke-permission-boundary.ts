/**
 * Offline adversarial smoke for orchestration permission boundaries.
 * Run: npm run smoke:permission-boundary
 */
import assert from "node:assert";
import { tool } from "ai";
import { z } from "zod";
import { enforceToolPolicy, toolPolicyDecision } from "../packages/leash-core/src/tool-policy.ts";

const registry = {
  bash: tool({ description: "read-only file snapshot", inputSchema: z.object({ command: z.string() }), execute: async () => ({ text: "ok" }) }),
  get_app_state: tool({ description: "desktop state", inputSchema: z.object({ app: z.string() }), execute: async () => ({ text: "bad" }) }),
  type_text: tool({ description: "type into app", inputSchema: z.object({ app: z.string(), text: z.string() }), execute: async () => ({ text: "bad" }) }),
  install_mcp_repo: tool({ description: "install", inputSchema: z.object({ url: z.string() }), execute: async () => ({ text: "bad" }) }),
  ha_call_service: tool({ description: "home write", inputSchema: z.object({ domain: z.string(), service: z.string() }), execute: async () => ({ text: "bad" }) }),
  unknown_external_tool: tool({ description: "external MCP", inputSchema: z.object({}), execute: async () => ({ text: "bad" }) }),
};

const subagent = enforceToolPolicy(registry, { route: "agent", subagent: true, runId: "r", stepId: "s" });
assert.deepEqual(Object.keys(subagent), ["bash"], "sub-agent receives only safe read tool");

const background = enforceToolPolicy(registry, { route: "background", background: true, runId: "r", stepId: "s" });
assert.deepEqual(Object.keys(background), [], "background run cannot use shell/device/admin/external tools by default");

assert.equal(toolPolicyDecision("search_graph", { route: "chat", publicMesh: true }).ok, false, "private context blocked on public mesh");
assert.equal(toolPolicyDecision("deep_research", { route: "chat", background: true }).ok, true, "network research is background-eligible only through policy");
assert.equal(toolPolicyDecision("schedule_job", { route: "agent", subagent: true }).ok, false, "scheduler mutation blocked in sub-agent");
assert.equal(toolPolicyDecision("upsert_mcp_server", { route: "background", background: true }).ok, false, "MCP admin blocked in background");

console.log("smoke:permission-boundary PASS");
