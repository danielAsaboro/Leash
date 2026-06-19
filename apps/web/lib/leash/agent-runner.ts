/**
 * Agent orchestration (server-only) — one CALLABLE sub-agent tool per enabled agent, built on the
 * Vercel AI SDK's first-class agent primitives so it renders + behaves like the rest of the stack.
 *
 * This is the AI SDK "streaming subagent" pattern (ai-sdk-core/subagents), verbatim:
 *   · each subagent is a `ToolLoopAgent` — the SAME primitive as the main chat agent (agent.ts) —
 *     with its own model, instructions (= the agent's body + preloaded skills), and a RESTRICTED
 *     toolset (declared `tools:` ∩ registry − disallowed − approval-gated − nesting).
 *   · the tool's `execute` is an `async function*` that streams the subagent's run through
 *     `readUIMessageStream(result.toUIMessageStream())`, YIELDING accumulated UIMessages — so the
 *     /chat page renders the subagent's progress (its nested tool calls + text) as preliminary
 *     tool results, the standard AI SDK rendering path.
 *   · `toModelOutput` maps that full transcript down to just the final summary text for the MAIN
 *     model (context offloading — the subagent may burn many tokens; the orchestrator sees a summary).
 *
 * Tool KEY is `agent__<plugin>__<name>` — AI SDK / OpenAI tool keys reject the `:` in a namespaced
 * agent slug. Emitted count is CAPPED so many enabled agents can't overflow the serve's ~22-schema
 * tool budget. QVAC wedge rule: NO abortSignal anywhere, maxRetries 0 (a retry re-pays a hung decode).
 */
import "server-only";
import { tool, ToolLoopAgent, stepCountIs, readUIMessageStream, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { toolNeedsApproval, disabledTools } from "./tool-config.ts";
import { getSkill } from "./skills-store.ts";
import { loopLog } from "./loop-diagnostics.ts";
import type { Agent } from "./agents-store.ts";
import { mcpToolNamesForServers, connectInline } from "./mcp.ts";
import { grantedNames } from "./agent-grants.ts";
import { readMemoryContext, agentMemoryTools } from "./agent-memory.ts";
import { buildAgentFallbackInstructions } from "./prompt.ts";

/** Max agent tools emitted at once — each is one schema; cap keeps the active toolset under budget. */
const AGENT_TOOLS_CAP = 8;
/** Orchestration tools a sub-agent can never reach (no agent/skill nesting). */
const NO_NEST = new Set(["run_skill", "submit_plan"]);

/**
 * Toolless-hang guard (mirrors the main chat route): the qvac serve runs qwen3-4b with
 * tools:true/toolsMode:dynamic ("tools_compact"), which REJECTS a chat request that carries no tools.
 * So a pure-reasoning subagent (a drafter/reviewer with no declared tools) would hang. We hand it ONE
 * harmless keep-alive tool to satisfy the serve; the model can ignore it.
 */
const KEEPALIVE_TOOLS: ToolSet = {
  note: tool({
    description: "Optionally jot a brief working note to yourself. You usually don't need this.",
    inputSchema: z.object({ note: z.string().describe("A short note.") }),
    execute: async ({ note }) => ({ noted: note }),
  }),
};

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
    if (await toolNeedsApproval(n)) continue; // subagents can't pause on a human approval card (AI SDK caveat)
    names.push(n);
  }
  if (agent.mcpServers.refs.length) {
    const serverToolNames = await mcpToolNamesForServers(agent.mcpServers.refs);
    const chosen = new Set(names);
    for (const n of grantedNames(serverToolNames, new Set(Object.keys(registry)), chosen, denied)) {
      if (off.has(n)) continue; // a globally disabled tool stays disabled even via a reference
      if (await toolNeedsApproval(n)) continue; // delegates still can't use approval-gated tools
      names.push(n);
    }
  }
  const tools: ToolSet = Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]]));
  return { tools, names };
}

/** Preload the full body of each `skills:` entry into the sub-agent's instructions (enabled skills only). */
async function preloadSkills(agent: Agent): Promise<string> {
  if (!agent.skills.length) return "";
  const loaded = (await Promise.all(agent.skills.map((s) => getSkill(s)))).filter((s) => s && s.enabled);
  if (!loaded.length) return "";
  return "\n\n--- Preloaded skills (follow their instructions) ---\n" + loaded.map((s) => `### Skill: ${s!.name}\n${s!.body}`).join("\n\n");
}

/** Extract the subagent's final text from its accumulated UIMessage (for toModelOutput). */
function finalText(message: UIMessage | undefined): string {
  const parts = message?.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p && p.type === "text" && typeof (p as { text?: unknown }).text === "string") return (p as { text: string }).text.trim();
  }
  return "";
}

/** Build one callable sub-agent tool — a streaming `ToolLoopAgent` behind a `tool()` (the AI SDK subagent pattern). */
function buildOne(agent: Agent, registry: ToolSet): ToolSet {
  return {
    [agentToolKey(agent.slug)]: tool({
      description:
        `Delegate a sub-task to the "${agent.name}" agent (${agent.slug}). ${agent.description || "A focused sub-agent."} ` +
        `It runs autonomously in its own context with its own tools and returns the result. Pass a clear, self-contained task.`,
      inputSchema: z.object({
        task: z.string().describe(`The specific, self-contained task for the ${agent.name} agent to carry out.`),
      }),
      // Streaming subagent: yields accumulated UIMessages so the UI renders progress (preliminary tool results).
      execute: async function* ({ task }) {
        const { tools, names } = await agentTools(agent, registry);
        const skillCtx = await preloadSkills(agent);
        // Initialize inline with safe defaults before the try — guaranteed close() in finally.
        let inline: { tools: ToolSet; close: () => Promise<void> } = { tools: {}, close: async () => {} };
        try {
          // Connect inline MCP servers for this delegate only — isolated from the parent conversation.
          if (agent.mcpServers.inline.length) inline = await connectInline(agent.mcpServers.inline);
          // Compute memory context + sandboxed tools when memory: is set.
          const memCtx = agent.memory ? await readMemoryContext(agent.slug) : "";
          const memTools = agent.memory ? agentMemoryTools(agent.slug) : {};
          // Merge declared tools + inline MCP tools + memory tools; apply toolless-hang guard to the merged set.
          const merged: ToolSet = { ...(names.length ? tools : {}), ...inline.tools, ...memTools };
          const runTools = Object.keys(merged).length ? merged : KEEPALIVE_TOOLS;
          loopLog(`agent ${agent.slug}: ${task.slice(0, 60)} (${Object.keys(runTools).length} tool(s), ${agent.skills.length} skill(s), ${agent.mcpServers.inline.length} inline mcp)`);
          // The subagent is a ToolLoopAgent — same primitive as the main chat agent — with an isolated context.
          // QVAC wedge rule: maxRetries 0 and NEVER an abortSignal (an aborted decode wedges the serve).
          const sub = new ToolLoopAgent({
            model: chatModel(`agent:${agent.slug}`, agent.model || undefined),
            instructions: (agent.body || buildAgentFallbackInstructions(agent.name)) + skillCtx + memCtx,
            temperature: 0.6,
            topP: 0.95,
            maxRetries: 0,
            tools: runTools,
            stopWhen: stepCountIs(agent.maxTurns),
          });
          const result = await sub.stream({ prompt: task });
          for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) {
            yield message;
          }
        } catch (e) {
          // Surface a UIMessage-shaped error so the tool output stays one consistent type.
          yield { id: `agent-err-${agent.slug}`, role: "assistant", parts: [{ type: "text", text: `The "${agent.slug}" agent failed: ${e instanceof Error ? e.message : String(e)}` }] } as UIMessage;
        } finally {
          // Always disconnect inline servers — even on error (scoped to this delegate, not the global registry).
          await inline.close();
        }
      },
      // The MAIN model sees only the subagent's final summary (context offloading); the UI keeps the full transcript.
      toModelOutput: ({ output }) => ({ type: "text", value: finalText(output as UIMessage | undefined) || `(the ${agent.slug} agent returned no text)` }),
    }),
  };
}

/**
 * Build the sub-agent tools for the enabled agents (capped). Each delegates FROM the base registry
 * (no nesting on itself). Pass the result into the chat route's tool registry.
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
