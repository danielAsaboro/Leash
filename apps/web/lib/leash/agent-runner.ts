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
import { getToolName, isToolUIPart, tool, ToolLoopAgent, isStepCount, readUIMessageStream, type ToolSet, type UIMessage } from "ai";
import { join } from "node:path";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { toolNeedsApproval, disabledTools, leashToolApproval } from "./tool-config.ts";
import { getSkill } from "./skills-store.ts";
import { loopLog } from "./loop-diagnostics.ts";
import type { Agent } from "./agents-store.ts";
import { mcpToolNamesForServers, connectInline } from "./mcp.ts";
import { grantedNames } from "./agent-grants.ts";
import { readMemoryContext, agentMemoryTools } from "./agent-memory.ts";
import { buildAgentDelegateContextPrompt, buildAgentFallbackInstructions, NO_THINK_DIRECTIVE } from "./prompt.ts";
import { buildAgentDelegateContextPacket } from "./agent-context.ts";
import { enforceToolPolicy, filterToolNamesForContext } from "@mycelium/leash-core/tool-policy";
import { loadPlugin, pluginToolPolicies } from "@mycelium/leash-core/plugin-loader";
import { PLUGINS_DIR } from "@mycelium/leash-core/plugins-store";
import { buildContextCapsule } from "@mycelium/leash-core/context-capsule";
import { getGoalRun, recordGoalRunModelTrace, startGoalRunStep, updateGoalRunStep } from "@mycelium/leash-core/goal-runs";
import { agentToolKey } from "./agent-keys.ts";
import { qvacReasoningProviderOptions } from "./reasoning-policy.ts";
import {
  LEASH_AGENT_TIMEOUT,
  createLeashRuntimeContext,
  createLifecycleTimingTransform,
  recordAgentLifecycle,
  toolContextsFor,
  withScopedToolContext,
  type LeashToolContext,
} from "./runtime-lifecycle.ts";
import { initialToolBatchInstruction, initialToolPolicyForTask, toolPolicyForStep } from "./agent-tool-batching.ts";
import { appendAuthoritativeToolEvidence, structuredAuthoritativeToolEvidence, type AuthoritativeToolEvidence } from "./agent-authoritative-results.ts";
import { memoizeToolExecutions } from "./agent-tool-idempotency.ts";
import { subagentExecutionPolicy } from "./agent-execution-policy.ts";
import type { ExplicitAgentTask, PlannedReadCall } from "./agent-explicit-plan.ts";

/** Max agent tools emitted at once — each is one schema; cap keeps the active toolset under budget. */
const AGENT_TOOLS_CAP = 8;
/** Orchestration tools a sub-agent can never reach (no agent/skill nesting). */
const NO_NEST = new Set(["run_skill", "submit_plan"]);

export interface AgentToolRuntimeContext {
  getGoalRunId?: () => string | undefined;
  getCurrentUserTurn?: () => string | undefined;
  getSummarySection?: () => string | undefined;
  getRecentConversation?: () => string | undefined;
}

/** Resolve a sub-agent's toolset: declared tools that exist, aren't disabled / denied / approval-gated / nesting. */
async function agentTools(agent: Agent, registry: ToolSet): Promise<{ tools: ToolSet; names: string[] }> {
  const off = await disabledTools();
  const denied = new Set(agent.disallowedTools);
  const names: string[] = [];
  const pluginPolicies = agent.pluginId
    ? pluginToolPolicies((await loadPlugin(join(PLUGINS_DIR, agent.pluginId))).manifest)
    : {};
  const policyContext = { route: "agent" as const, subagent: true, pluginPolicies };
  const policyAllowed = new Set(filterToolNamesForContext(agent.tools, policyContext));
  for (const n of agent.tools) {
    if (!policyAllowed.has(n)) continue;
    if (NO_NEST.has(n) || n.startsWith("agent__") || !registry[n] || off.has(n) || denied.has(n)) continue;
    if (pluginPolicies[n]?.approval === "required" || (!pluginPolicies[n] && (await toolNeedsApproval(n)))) continue; // subagents can't pause on a human approval card (AI SDK caveat)
    names.push(n);
  }
  if (agent.mcpServers.refs.length) {
    const serverToolNames = await mcpToolNamesForServers(agent.mcpServers.refs);
    const chosen = new Set(names);
    for (const n of grantedNames(serverToolNames, new Set(Object.keys(registry)), chosen, denied)) {
      if (!filterToolNamesForContext([n], policyContext).length) continue;
      if (off.has(n)) continue; // a globally disabled tool stays disabled even via a reference
      if (pluginPolicies[n]?.approval === "required" || (!pluginPolicies[n] && (await toolNeedsApproval(n)))) continue; // delegates still can't use approval-gated tools
      names.push(n);
    }
  }
  const tools: ToolSet = enforceToolPolicy(Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]])), policyContext);
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

function authoritativeResult(message: UIMessage | undefined): string {
  const evidence: AuthoritativeToolEvidence[] = [];
  for (const part of message?.parts ?? []) {
    if (!isToolUIPart(part)) continue;
    if (part.state === "output-available") {
      evidence.push({ toolName: getToolName(part), status: "output", value: part.output });
    } else if (part.state === "output-error") {
      evidence.push({ toolName: getToolName(part), status: "error", value: part.errorText });
    }
  }
  return appendAuthoritativeToolEvidence(finalText(message), evidence);
}

async function parentContextCapsule(input: { goalRunId?: string; task: string; currentUserTurn?: string; summarySection?: string; recentConversation?: string; agentName: string }): Promise<{ text: string; tokenEstimate: number; truncated: boolean; includedStepIds: string[]; artifactIds: string[] }> {
  if (!input.goalRunId) return { text: "", tokenEstimate: 0, truncated: false, includedStepIds: [], artifactIds: [] };
  const run = await getGoalRun(input.goalRunId);
  if (!run) return { text: "", tokenEstimate: 0, truncated: false, includedStepIds: [], artifactIds: [] };
  return buildContextCapsule({
    run,
    currentStep: `Delegate a focused sub-task to ${input.agentName}; Leash will synthesize the final user answer.`,
    // The run title already carries the current user goal and the packet carries
    // the delegated task separately. Only add prior continuity here; repeating
    // the current turn three times increases prefill without adding evidence.
    relevantContext: [input.recentConversation, input.summarySection].filter((s): s is string => !!s),
    maxChars: 1600,
  });
}

/** Build one callable sub-agent tool — a streaming `ToolLoopAgent` behind a `tool()` (the AI SDK subagent pattern). */
function buildOne(agent: Agent, registry: ToolSet, runtime: AgentToolRuntimeContext = {}): ToolSet {
  const toolKey = agentToolKey(agent.slug);
  return {
    [toolKey]: tool({
      description:
        `Delegate a sub-task to the "${agent.name}" agent (${agent.slug}). ${agent.description || "A focused sub-agent."} ` +
        `It runs autonomously in its own context with its own tools and returns the result. Pass a clear, self-contained task.`,
      inputSchema: z.object({
        task: z.string().describe(`The specific, self-contained task for the ${agent.name} agent to carry out.`),
      }),
      // Streaming subagent: yields accumulated UIMessages so the UI renders progress (preliminary tool results).
      execute: async function* ({ task }, execution) {
        const { tools, names } = await agentTools(agent, registry);
        const skillCtx = await preloadSkills(agent);
        const goalRunId = runtime.getGoalRunId?.();
        const startedAt = Date.now();
        let ledgerStepId: string | undefined;
        let lastMessage: UIMessage | undefined;
        // Initialize inline with safe defaults before the try — guaranteed close() in finally.
        let inline: { tools: ToolSet; close: () => Promise<void> } = { tools: {}, close: async () => {} };
        try {
          // Connect inline MCP servers for this delegate only — isolated from the parent conversation.
          if (agent.mcpServers.inline.length) inline = await connectInline(agent.mcpServers.inline);
          // Compute memory context + sandboxed tools when memory: is set.
          const memCtx = agent.memory ? await readMemoryContext(agent.slug) : "";
          const memTools = agent.memory ? agentMemoryTools(agent.slug) : {};
          // Merge declared tools + inline MCP tools + memory tools. Empty is a valid
          // pure-reasoning delegate; the configured serve supports toolless calls.
          const merged: ToolSet = enforceToolPolicy({ ...(names.length ? tools : {}), ...inline.tools, ...memTools }, { route: "agent", subagent: true });
          const runTools = memoizeToolExecutions(withScopedToolContext(merged));
          const parentCapsule = await parentContextCapsule({
            goalRunId,
            task,
            currentUserTurn: runtime.getCurrentUserTurn?.(),
            summarySection: runtime.getSummarySection?.(),
            recentConversation: runtime.getRecentConversation?.(),
            agentName: agent.name,
          });
          const packet = buildAgentDelegateContextPacket({
            agent: { slug: agent.slug, name: agent.name, description: agent.description },
            task,
            parentContextCapsule: parentCapsule.text,
            summarySection: runtime.getSummarySection?.(),
            recentConversation: runtime.getRecentConversation?.(),
            currentUserTurn: runtime.getCurrentUserTurn?.(),
            selectedTools: Object.keys(merged),
            memoryContext: memCtx,
            maxChars: Number(process.env["LEASH_AGENT_CONTEXT_CHARS"] ?? 3200),
          });
          if (goalRunId) {
            const step = await startGoalRunStep(goalRunId, {
              title: `Delegate to ${agent.name}`,
              route: "agent",
              model: toolKey,
              contextCapsule: packet.text,
              contextTokensEstimate: packet.tokenEstimate,
            });
            ledgerStepId = step.id;
          }
          loopLog(`agent ${agent.slug}: ${task.slice(0, 60)} (${Object.keys(runTools).length} tool(s), ${agent.skills.length} skill(s), ${agent.mcpServers.inline.length} inline mcp)`);
          // The subagent is a ToolLoopAgent — same primitive as the main chat agent — with an isolated context.
          // QVAC wedge rule: maxRetries 0 and NEVER an abortSignal (an aborted decode wedges the serve).
          const delegatePrompt = buildAgentDelegateContextPrompt(packet);
          const executionPolicy = subagentExecutionPolicy(agent.slug, task);
          const initialToolPolicy = initialToolPolicyForTask(task, Object.keys(runTools));
          const batchInstruction = initialToolBatchInstruction(task, Object.keys(runTools));
          const parentContext = execution.context as Partial<LeashToolContext> | undefined;
          const subRuntime = createLeashRuntimeContext({
            route: "agent",
            chatId: parentContext?.chatId,
            runId: goalRunId ?? parentContext?.runId,
            stepId: ledgerStepId,
          });
          const sub = new ToolLoopAgent<never, ToolSet, typeof subRuntime>({
            model: chatModel(`agent:${agent.slug}`, agent.model || undefined),
            instructions: [(agent.body || buildAgentFallbackInstructions(agent.name)), skillCtx, delegatePrompt, batchInstruction].filter(Boolean).join("\n\n"),
            temperature: executionPolicy.temperature,
            topP: executionPolicy.topP,
            maxOutputTokens: executionPolicy.maxOutputTokens,
            maxRetries: 0,
            tools: runTools,
            toolOrder: Object.keys(runTools).sort(),
            runtimeContext: subRuntime,
            toolsContext: toolContextsFor(runTools, subRuntime),
            toolApproval: leashToolApproval,
            prepareStep: ({ stepNumber }) => ({
              toolChoice: toolPolicyForStep(initialToolPolicy, stepNumber),
            }),
            reasoning: executionPolicy.reasoning,
            providerOptions: qvacReasoningProviderOptions(executionPolicy.reasoning === "high"),
            stopWhen: isStepCount(agent.maxTurns),
            onStart: (event) => recordAgentLifecycle(event.runtimeContext, { event: "agent_start", callId: event.callId, modelId: event.modelId }),
            onStepStart: (event) => recordAgentLifecycle(event.runtimeContext, { event: "step_start", callId: event.callId, modelId: event.modelId, stepNumber: event.stepNumber }),
            onStepEnd: (event) => recordAgentLifecycle(event.runtimeContext, { event: "step_end", callId: event.callId, stepNumber: event.stepNumber, finishReason: event.finishReason }),
            onEnd: (event) => recordAgentLifecycle(event.finalStep.runtimeContext, { event: "agent_end", callId: event.callId, stepNumber: event.stepNumber, finishReason: event.finishReason, durationMs: Date.now() - event.finalStep.runtimeContext.startedAt }),
          });
          const result = await sub.stream({
            prompt: task,
            timeout: LEASH_AGENT_TIMEOUT,
            experimental_transform: createLifecycleTimingTransform(subRuntime),
          });
          for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) {
            lastMessage = message;
            yield message;
          }
          const out = authoritativeResult(lastMessage) || `(the ${agent.slug} agent returned no text)`;
          if (goalRunId && ledgerStepId) {
            await updateGoalRunStep(goalRunId, ledgerStepId, { status: "done", summary: out });
            await recordGoalRunModelTrace(goalRunId, {
              stepId: ledgerStepId,
              model: agent.model || "chat",
              alias: toolKey,
              startedAt,
              finishedAt: Date.now(),
              contextTokensEstimate: packet.tokenEstimate,
            });
          }
        } catch (e) {
          // Surface a UIMessage-shaped error so the tool output stays one consistent type.
          if (goalRunId && ledgerStepId) await updateGoalRunStep(goalRunId, ledgerStepId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
          yield { id: `agent-err-${agent.slug}`, role: "assistant", parts: [{ type: "text", text: `The "${agent.slug}" agent failed: ${e instanceof Error ? e.message : String(e)}` }] } as UIMessage;
        } finally {
          // Always disconnect inline servers — even on error (scoped to this delegate, not the global registry).
          await inline.close();
        }
      },
      // The MAIN model sees only the subagent's final summary (context offloading); the UI keeps the full transcript.
      toModelOutput: ({ output }) => ({ type: "text", value: authoritativeResult(output as UIMessage | undefined) || `(the ${agent.slug} agent returned no text)` }),
    }),
  };
}

/**
 * Build the sub-agent tools for the enabled agents (capped). Each delegates FROM the base registry
 * (no nesting on itself). Pass the result into the chat route's tool registry.
 */
export function buildAgentTools(agents: Agent[], registry: ToolSet, runtime: AgentToolRuntimeContext = {}): ToolSet {
  const capped = agents.slice(0, AGENT_TOOLS_CAP);
  if (agents.length > capped.length) {
    console.warn(`leash: ${agents.length} enabled agents (> cap ${AGENT_TOOLS_CAP}) — emitting the first ${capped.length}: dropped ${agents.slice(AGENT_TOOLS_CAP).map((a) => a.slug).join(", ")}`);
  }
  let out: ToolSet = {};
  for (const agent of capped) out = { ...out, ...buildOne(agent, registry, runtime) };
  return out;
}

export type PlannedAgentEvent =
  | { type: "tool_start"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; input: Record<string, unknown>; output: unknown; durationMs: number }
  | { type: "agent_start"; agent: ExplicitAgentTask }
  | { type: "agent_end"; agent: ExplicitAgentTask; output: string; durationMs: number };

export interface PlannedAgentOrchestrationResult {
  text: string;
  evidence: AuthoritativeToolEvidence[];
  agents: Array<{ agent: ExplicitAgentTask; output: string; durationMs: number }>;
}

type PlannedAgentOrchestrationInput = {
  request: string;
  currentUserTurn: string;
  summarySection?: string;
  recentConversation?: string;
  goalRunId: string;
  mainStepId: string;
  modelAlias: string;
  agents: Agent[];
  plans: ExplicitAgentTask[];
  readCalls: PlannedReadCall[];
  onEvent?: (event: PlannedAgentEvent) => void | Promise<void>;
};

async function executePlannedReadCall(
  call: PlannedReadCall,
  runtime: ReturnType<typeof createLeashRuntimeContext>,
): Promise<{ evidence: AuthoritativeToolEvidence; durationMs: number }> {
  const startedAt = Date.now();
  const definition = call.tool as {
    execute?: (input: unknown, options: Record<string, unknown>) => unknown;
  };
  if (!definition.execute) throw new Error(`planned read tool ${call.toolName} is not executable`);
  const contexts = toolContextsFor({ [call.toolName]: call.tool }, runtime);
  const raw = definition.execute(call.input, {
    toolCallId: `planned-${call.toolName}-${runtime.requestId}`,
    messages: [],
    context: contexts[call.toolName],
  });
  let output: unknown;
  if (raw && typeof raw === "object" && Symbol.asyncIterator in raw) {
    for await (const value of raw as AsyncIterable<unknown>) output = value;
  } else {
    output = await raw;
  }
  return {
    evidence: { toolName: call.toolName, status: "output", value: output },
    durationMs: Date.now() - startedAt,
  };
}

function findingSubmissionTool(): ToolSet {
  return {
    submit_finding: tool({
      description: "Submit the specialist's compact, evidence-grounded finding to the Leash orchestrator.",
      inputSchema: z.object({ finding: z.string().min(1).max(2_000) }),
      execute: async ({ finding }) => ({ finding }),
    }),
  };
}

function synthesisSubmissionTool(): ToolSet {
  return {
    submit_synthesis: tool({
      description: "Submit the final user-facing synthesis after all specialist findings are available.",
      inputSchema: z.object({ answer: z.string().min(1).max(4_000) }),
      execute: async ({ answer }) => ({ answer }),
    }),
  };
}

function submittedField(result: { toolCalls?: unknown }, toolName: string, field: string): string {
  const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const record = call as { toolName?: unknown; input?: unknown };
    if (record.toolName !== toolName || !record.input || typeof record.input !== "object") continue;
    const value = (record.input as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function submittedFieldFromText(text: string, toolName: string, field: string): string {
  const trimmed = text.trim();
  const marker = trimmed.indexOf(toolName);
  const jsonStart = trimmed.indexOf("{", Math.max(0, marker));
  if (marker < 0 || jsonStart < 0) return "";
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function requiredGroundedIdentifiers(request: string, evidence: string[]): string[] {
  if (!/\b(?:batch\s+id|marker|identifier|reference|tracking\s+(?:id|code)|confirmation\s+code)\b/i.test(request)) return [];
  const ids = new Set<string>();
  const pattern = /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
  for (const value of evidence) {
    for (const match of value.matchAll(pattern)) ids.add(match[0]);
  }
  return [...ids].slice(0, 12);
}

function ensureGroundedIdentifiers(answer: string, identifiers: string[]): string {
  const missing = identifiers.filter((identifier) => !answer.includes(identifier));
  if (missing.length === 0) return answer;
  return `${answer.trim()}\n\nGrounded identifiers: ${missing.map((identifier) => `\`${identifier}\``).join(", ")}.`;
}

/**
 * Fast path for unambiguous explicit delegation on one inference device:
 * execute mandated reads once in parallel, run specialists sequentially from
 * the same authoritative evidence, then perform one bounded parent synthesis.
 */
export async function runPlannedAgentOrchestration(
  input: PlannedAgentOrchestrationInput,
): Promise<PlannedAgentOrchestrationResult> {
  const runtime = createLeashRuntimeContext({
    route: "agent",
    runId: input.goalRunId,
    stepId: input.mainStepId,
  });
  const evidence = await Promise.all(input.readCalls.map(async (call) => {
    await input.onEvent?.({ type: "tool_start", toolName: call.toolName, input: call.input });
    recordAgentLifecycle(runtime, { event: "tool_start", toolName: call.toolName });
    const result = await executePlannedReadCall(call, runtime);
    recordAgentLifecycle(runtime, { event: "tool_end", toolName: call.toolName, durationMs: result.durationMs });
    await input.onEvent?.({ type: "tool_end", toolName: call.toolName, input: call.input, output: result.evidence.value, durationMs: result.durationMs });
    return result.evidence;
  }));
  const evidenceJson = structuredAuthoritativeToolEvidence(evidence);
  const outcomes: PlannedAgentOrchestrationResult["agents"] = [];

  for (const plan of input.plans) {
    const agent = input.agents.find((candidate) => candidate.slug === plan.slug);
    if (!agent) throw new Error(`explicit delegate ${plan.slug} is no longer available`);
    const allowed = await agentTools(agent, Object.fromEntries(input.readCalls.map((call) => [call.toolName, call.tool])) as ToolSet);
    if (plan.mandatedTools.some((name) => !allowed.names.includes(name))) {
      throw new Error(`${agent.name} is not allowed to use every mandated read tool`);
    }
    const skillCtx = await preloadSkills(agent);
    const memCtx = agent.memory ? await readMemoryContext(agent.slug) : "";
    const parentCapsule = await parentContextCapsule({
      goalRunId: input.goalRunId,
      task: plan.task,
      currentUserTurn: input.currentUserTurn,
      summarySection: input.summarySection,
      recentConversation: input.recentConversation,
      agentName: agent.name,
    });
    const packet = buildAgentDelegateContextPacket({
      agent: { slug: agent.slug, name: agent.name, description: agent.description },
      task: plan.task,
      parentContextCapsule: parentCapsule.text,
      summarySection: input.summarySection,
      recentConversation: input.recentConversation,
      currentUserTurn: input.currentUserTurn,
      selectedTools: plan.mandatedTools,
      memoryContext: memCtx,
      maxChars: Number(process.env["LEASH_AGENT_CONTEXT_CHARS"] ?? 3200),
    });
    const step = await startGoalRunStep(input.goalRunId, {
      title: `Delegate to ${agent.name}`,
      route: "agent",
      model: plan.toolName,
      contextCapsule: packet.text,
      contextTokensEstimate: packet.tokenEstimate,
    });
    const startedAt = Date.now();
    await input.onEvent?.({ type: "agent_start", agent: plan });
    const executionPolicy = subagentExecutionPolicy(agent.slug, plan.task);
    const delegateRuntime = createLeashRuntimeContext({ route: "agent", runId: input.goalRunId, stepId: step.id });
    const findingTool = findingSubmissionTool();
    const specialist = new ToolLoopAgent<never, ToolSet, typeof delegateRuntime>({
      model: chatModel(`planned-agent:${agent.slug}`, agent.model || input.modelAlias),
      instructions: [
        agent.body || buildAgentFallbackInstructions(agent.name),
        skillCtx,
        buildAgentDelegateContextPrompt(packet),
        "The orchestrator already executed the explicitly mandated read tools. Treat the following JSON as authoritative. Do not request or invent additional tool output.",
        evidenceJson,
        "Call submit_finding exactly once with a compact specialist finding for Leash to synthesize.",
        NO_THINK_DIRECTIVE,
      ].filter(Boolean).join("\n\n"),
      temperature: executionPolicy.temperature,
      topP: executionPolicy.topP,
      maxOutputTokens: Math.min(executionPolicy.maxOutputTokens, 220),
      maxRetries: 0,
      tools: findingTool,
      toolChoice: { type: "tool", toolName: "submit_finding" },
      runtimeContext: delegateRuntime,
      toolsContext: toolContextsFor(findingTool, delegateRuntime),
      reasoning: executionPolicy.reasoning,
      providerOptions: qvacReasoningProviderOptions(executionPolicy.reasoning === "high"),
      stopWhen: isStepCount(1),
    });
    const generated = await specialist.generate({
      prompt: `${NO_THINK_DIRECTIVE}\n${plan.task}\nReturn the compact finding now without hidden reasoning.`,
      timeout: LEASH_AGENT_TIMEOUT,
    });
    const output = submittedField(generated, "submit_finding", "finding");
    if (!output) throw new Error(`${agent.name} produced no visible specialist finding`);
    const durationMs = Date.now() - startedAt;
    outcomes.push({ agent: plan, output, durationMs });
    await updateGoalRunStep(input.goalRunId, step.id, { status: "done", summary: appendAuthoritativeToolEvidence(output, evidence) });
    await recordGoalRunModelTrace(input.goalRunId, {
      stepId: step.id,
      model: agent.model || input.modelAlias,
      alias: plan.toolName,
      startedAt,
      finishedAt: Date.now(),
      contextTokensEstimate: packet.tokenEstimate,
    });
    await input.onEvent?.({ type: "agent_end", agent: plan, output, durationMs });
  }

  const parentRuntime = createLeashRuntimeContext({ route: "chat", runId: input.goalRunId, stepId: input.mainStepId });
  const synthesisTool = synthesisSubmissionTool();
  const parent = new ToolLoopAgent<never, ToolSet, typeof parentRuntime>({
    model: chatModel("planned-agent-synthesis", input.modelAlias),
    instructions: [
      "You are Leash, synthesizing completed specialist work for the user.",
      "Use only the supplied current user evidence, authoritative tool evidence, and specialist findings.",
      "Copy identifiers, measured values, thresholds, and decisions exactly. Do not add unrelated next steps or tool advice.",
      "Call submit_synthesis exactly once with the final answer in at most 160 words.",
      NO_THINK_DIRECTIVE,
    ].join(" "),
    temperature: 0.2,
    topP: 0.8,
    maxOutputTokens: 260,
    maxRetries: 0,
    tools: synthesisTool,
    toolChoice: { type: "tool", toolName: "submit_synthesis" },
    runtimeContext: parentRuntime,
    toolsContext: toolContextsFor(synthesisTool, parentRuntime),
    reasoning: "none",
    providerOptions: qvacReasoningProviderOptions(false),
    stopWhen: isStepCount(1),
  });
  const parentPrompt = JSON.stringify({
    userRequest: input.request,
    currentUserEvidence: input.currentUserTurn,
    recentGroundedConversation: input.recentConversation,
    compactedConversationSummary: input.summarySection,
    toolEvidence: evidenceJson,
    specialists: outcomes.map(({ agent, output }) => ({ name: agent.name, task: agent.task, finding: output })),
  });
  const requiredIdentifiers = requiredGroundedIdentifiers(input.request, [
    input.currentUserTurn,
    input.recentConversation ?? "",
  ]);
  const final = await parent.generate({
    prompt: `${NO_THINK_DIRECTIVE}\n${parentPrompt}\nRequired exact identifiers: ${JSON.stringify(requiredIdentifiers)}\nReturn the final user-facing synthesis now without hidden reasoning.`,
    timeout: LEASH_AGENT_TIMEOUT,
  });
  const answer = submittedField(final, "submit_synthesis", "answer")
    || submittedFieldFromText(final.text, "submit_synthesis", "answer")
    || final.text.trim();
  return { text: ensureGroundedIdentifiers(answer, requiredIdentifiers), evidence, agents: outcomes };
}
