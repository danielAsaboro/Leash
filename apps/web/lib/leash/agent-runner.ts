/**
 * Agent orchestration (server-only) — one CALLABLE sub-agent tool per enabled plugin agent.
 *
 * Generalizes `buildSkillRunner` (skill-runner.ts): where `run_skill` is ONE tool that takes a slug,
 * each agent gets its OWN named tool so the model picks the right specialist directly (the Claude-Code
 * "subagent" UX). The sub-agent runs as a focused `generateText` over a RESTRICTED toolset — the
 * agent's declared `tools:` intersected with the live registry, minus its `disallowed-tools:`, minus
 * approval-gated tools (a non-streaming generateText can't pause on a human approval card, exactly as
 * in skill-runner) and minus the orchestration tools (no nesting). System prompt = the agent's body;
 * model = `chatModel(agent.model)`; bounded by `stopWhen: stepCountIs(maxTurns)`.
 *
 * Tool KEY is `agent__<plugin>__<name>` — AI SDK / OpenAI tool keys reject the `:` in the agent's
 * namespaced slug, so we map it to `__` and keep the human slug in the description (the reverse
 * mapping the UI reads). Emitted count is CAPPED (à la SKILL_TOOLS_CAP) so many enabled agents can't
 * overflow the serve's ~22-schema / 4096-token tool budget — quarantine + this cap are the guards.
 *
 * QVAC wedge rule: no abortSignal anywhere, maxRetries 0 (a retry re-pays a hung decode).
 */
import "server-only";
import { tool, generateText, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { toolNeedsApproval, disabledTools } from "./tool-config.ts";
import { getSkill } from "./skills-store.ts";
import { loopLog } from "./loop-diagnostics.ts";
import type { Agent } from "./agents-store.ts";
import type { LeashSource } from "./tools.ts";

/** Max agent tools emitted at once — each is one schema; cap keeps the active toolset under budget. */
const AGENT_TOOLS_CAP = 8;
/** Orchestration tools a sub-agent can never reach (no agent/skill nesting). */
const NO_NEST = new Set(["run_skill", "submit_plan"]);

/** The AI-SDK-safe tool key for an agent (its `<plugin>:<name>` slug can't contain `:`). */
export function agentToolKey(slug: string): string {
  return `agent__${slug.replace(/:/g, "__")}`;
}

/** Resolve a sub-agent's toolset: declared tools that exist, aren't disabled / denied / approval-gated / nesting. */
async function agentTools(agent: Agent, registry: ToolSet): Promise<{ tools: ToolSet; names: string[] }> {
  const off = await disabledTools();
  const denied = new Set(agent.disallowedTools);
  const names: string[] = [];
  for (const n of agent.tools) {
    if (NO_NEST.has(n) || n.startsWith("agent__") || !registry[n] || off.has(n) || denied.has(n)) continue;
    if (await toolNeedsApproval(n)) continue; // can't pause on approval inside generateText
    names.push(n);
  }
  const tools: ToolSet = Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]]));
  return { tools, names };
}

/** Preload the full body of each `skills:` entry into the sub-agent's system prompt (enabled skills only). */
async function preloadSkills(agent: Agent): Promise<string> {
  if (!agent.skills.length) return "";
  const loaded = (await Promise.all(agent.skills.map((s) => getSkill(s)))).filter((s) => s && s.enabled);
  if (!loaded.length) return "";
  return "\n\n--- Preloaded skills (follow their instructions) ---\n" + loaded.map((s) => `### Skill: ${s!.name}\n${s!.body}`).join("\n\n");
}

/** Build one callable sub-agent tool. The sub-agent runs the agent's body over its restricted toolset. */
function buildOne(agent: Agent, registry: ToolSet): ToolSet {
  return {
    [agentToolKey(agent.slug)]: tool({
      description:
        `Delegate a sub-task to the "${agent.name}" agent (${agent.slug}). ${agent.description || "A focused sub-agent."} ` +
        `It runs in its own context with its own tools and returns just the result. Pass a clear, self-contained task.`,
      inputSchema: z.object({
        task: z.string().describe(`The specific, self-contained task for the ${agent.name} agent to carry out.`),
      }),
      execute: async ({ task }) => {
        const { tools, names } = await agentTools(agent, registry);
        const skillCtx = await preloadSkills(agent);
        loopLog(`agent ${agent.slug}: ${task.slice(0, 60)} (${names.length} tool(s), ${agent.skills.length} preloaded skill(s))`);
        try {
          const r = await generateText({
            model: chatModel(`agent:${agent.slug}`, agent.model || undefined),
            system: (agent.body || `You are the "${agent.name}" agent. Carry out the task and return a concise result.`) + skillCtx,
            messages: [{ role: "user" as const, content: task }],
            temperature: 0.6,
            topP: 0.95,
            maxRetries: 0,
            ...(names.length ? { tools, stopWhen: stepCountIs(agent.maxTurns) } : {}),
          });
          const text = r.text.trim() || `(the ${agent.slug} agent returned no text)`;
          return { text, sources: [{ kind: "graph", title: `Agent · ${agent.name}`, snippet: task.slice(0, 120) }] as LeashSource[] };
        } catch (e) {
          return { text: `The "${agent.slug}" agent failed: ${e instanceof Error ? e.message : String(e)}`, sources: [] as LeashSource[] };
        }
      },
    }),
  };
}

/**
 * Build the sub-agent tools for the enabled plugin agents (capped). Each delegates FROM the base
 * registry (no nesting on itself). Pass the result into the chat route's tool registry.
 */
export function buildAgentTools(agents: Agent[], registry: ToolSet): ToolSet {
  const capped = agents.slice(0, AGENT_TOOLS_CAP);
  if (agents.length > capped.length) {
    console.warn(`leash: ${agents.length} enabled agents (> cap ${AGENT_TOOLS_CAP}) — emitting the first ${capped.length}: dropped ${agents.slice(AGENT_TOOLS_CAP).map((a) => a.slug).join(", ")}`);
  }
  let out: ToolSet = {};
  for (const agent of capped) out = { ...out, ...buildOne(agent, registry) };
  return out;
}
