/**
 * Skill orchestration (server-only) — the `run_skill` tool: delegate a sub-task to ANOTHER skill,
 * which runs as a SUB-AGENT in its own focused context with its own tools and returns just the
 * result. This is what makes multi-skill workflows work WITHOUT bloating the parent's context:
 * the parent keeps one active skill (lean), and reaches for others on demand. It also gives the
 * model a REAL tool to invoke another skill — instead of emitting `<tool_call>` text for a skill
 * whose tools aren't loaded (the within-turn-orchestration failure the forgiving-parser detector caught).
 *
 * Two execution modes, chosen by the target skill:
 *   · SINGLE-SHOT (no `steps:`): one `generateText` over the skill body — the model free-runs.
 *   · DETERMINISTIC PIPELINE (`steps:` declared): the harness drives the steps IN ORDER, the model
 *     does ONE sub-task per step (earlier steps' results fed forward), and never decides "am I done?".
 *     This is the fix for chat's dependent-step / Implicit-Action failure (verified 2026-06-12:
 *     the 4B reliably does ONE sub-task and fires parallel calls, but drops the dependent NEXT call at
 *     the continuation boundary — and a scratchpad nudge, though confirmed-injected, did NOT fix it).
 *     Moving the step-ordering decision OUT of the model and INTO the harness is the deep-research-
 *     recommended placement of the planning burden for a small model (author-time, not model-time).
 *
 * The sub-agent gets the skill's declared tools MINUS any that are approval-gated or disabled — a
 * non-streaming `generateText` can't pause on a human approval card, so side-effectful actions
 * (Open Computer Use actions, ha_call_service, installs) stay on the main turn. Sub-agents don't nest (no run_skill).
 */
import "server-only";
import { tool, generateText, isStepCount, type ToolSet } from "ai";
import { join } from "node:path";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { getSkill, type Skill } from "./skills-store.ts";
import { toolNeedsApproval, disabledTools } from "./tool-config.ts";
import { loopLog } from "./loop-diagnostics.ts";
import type { LeashSource } from "./tools.ts";
import { buildSkillStepSystemPrompt, buildSkillSubtaskSystemPrompt } from "./prompt.ts";
import { qvacReasoningProviderOptions } from "./reasoning-policy.ts";
import { runFileFinderFastPath } from "./file-finder-fast-path.ts";
import { enforceToolPolicy, filterToolNamesForContext } from "@mycelium/leash-core/tool-policy";
import { parsePluginSlug } from "@mycelium/leash-core/plugin-manifest";
import { loadPlugin, pluginToolPolicies } from "@mycelium/leash-core/plugin-loader";
import { PLUGINS_DIR } from "@mycelium/leash-core/plugins-store";
import { buildContextCapsule } from "@mycelium/leash-core/context-capsule";
import { getGoalRun, startGoalRunStep, updateGoalRunStep, recordGoalRunModelTrace, type GoalRunRoute } from "@mycelium/leash-core/goal-runs";
import {
  LEASH_AGENT_TIMEOUT,
  createLeashRuntimeContext,
  recordAgentLifecycle,
  toolContextsFor,
  withScopedToolContext,
  type LeashRuntimeContext,
} from "./runtime-lifecycle.ts";

/** Step budget for a single-shot delegated sub-skill (its own small tool loop). */
const SUB_STEPS = 6;
/** Per-step budget inside a deterministic pipeline — each step is ONE bounded sub-task (tool → report). */
const PIPELINE_STEP_BUDGET = 3;

/**
 * QVAC qwen3 is served with tools:true/toolsMode:dynamic. SDK 0.13.x rejects
 * requests with an empty tools array in that mode, so delegated skills that have
 * no executable sub-tools still need one harmless schema.
 */
const KEEPALIVE_TOOLS: ToolSet = {
  note: tool({
    description: "Compatibility sentinel only. Do not call this tool; answer directly in text.",
    inputSchema: z.object({ note: z.string().describe("A short note.") }),
    execute: async ({ note }) => ({ noted: note }),
  }),
};

/** Forced structured submission for prose-only pipeline steps. Small local models can spend the
 * entire visible budget in hidden reasoning or call the compatibility sentinel despite
 * `toolChoice:"none"`; a typed submission makes every step return usable text exactly once. */
const PIPELINE_OUTPUT_TOOLS: ToolSet = {
  submit_step: tool({
    description: "Submit the completed result for this pipeline step.",
    inputSchema: z.object({ text: z.string().min(1).describe("The concise result of this step.") }),
    execute: async ({ text }) => ({ text }),
  }),
};

/** Resolve the sub-agent toolset for a skill: declared tools that exist, aren't disabled/approval-gated,
 *  and aren't run_skill (no nesting). Returns the live ToolSet plus the names skipped for approval. */
async function subAgentTools(skill: Skill, registry: ToolSet): Promise<{ subTools: ToolSet; names: string[]; skipped: string[] }> {
  const off = await disabledTools();
  const names: string[] = [];
  const skipped: string[] = [];
  const pluginSlug = parsePluginSlug(skill.slug);
  const pluginPolicies = pluginSlug
    ? pluginToolPolicies((await loadPlugin(join(PLUGINS_DIR, pluginSlug.id))).manifest)
    : {};
  const policyContext = { route: "skill" as const, subagent: true, pluginPolicies };
  const policyAllowed = new Set(filterToolNamesForContext(skill.tools, policyContext));
  for (const n of skill.tools) {
    if (n === "run_skill" || !registry[n] || off.has(n)) continue;
    if (pluginPolicies[n]?.approval === "required" || (!pluginPolicies[n] && (await toolNeedsApproval(n)))) {
      skipped.push(n);
      continue;
    }
    if (!policyAllowed.has(n)) continue;
    names.push(n);
  }
  const subTools: ToolSet = enforceToolPolicy(Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]])), policyContext);
  return { subTools, names, skipped };
}

/** Remove reasoning that leaked because a decode hit its cap before closing `</think>`. */
function cleanPipelineText(value: string): string {
  let text = value.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = text.search(/<think>/i);
  if (open >= 0) text = text.slice(0, open);
  return text.replace(/<\/?think>/gi, "").trim();
}

function submittedStepFromText(value: string): string {
  const text = cleanPipelineText(value);
  const marker = text.indexOf("submit_step");
  const jsonStart = text.indexOf("{", Math.max(0, marker));
  if (marker < 0 || jsonStart < 0) return text;
  try {
    const parsed = JSON.parse(text.slice(jsonStart)) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

/** Common generateText settings for a sub-skill call (qvac wedge rule: no abortSignal, maxRetries 0). */
function subCallBase(label: string, system: string, userContent: string, subTools: ToolSet, names: string[], stepBudget: number, suppliedRuntime?: LeashRuntimeContext) {
  const hasExecutableTools = names.length > 0;
  const runTools = withScopedToolContext(hasExecutableTools ? subTools : KEEPALIVE_TOOLS);
  const runtime = suppliedRuntime ?? createLeashRuntimeContext({ route: "skill" });
  const runSystem = hasExecutableTools
    ? system
    : `${system}\n\nNo executable tools are available in this delegated call. Answer directly in plain text. Do not call tools.`;
  return {
    model: chatModel(label),
    instructions: runSystem,
    messages: [{ role: "user" as const, content: userContent }],
    temperature: 0.6,
    topP: 0.95,
    maxRetries: 0,
    maxOutputTokens: hasExecutableTools ? 900 : 220,
    tools: runTools,
    toolOrder: Object.keys(runTools).sort(),
    runtimeContext: runtime,
    toolsContext: toolContextsFor(runTools, runtime),
    // subAgentTools already applies plugin policy, hard route policy, disabled state, and the
    // user approval configuration. Everything reaching this isolated loop is approval-free;
    // re-running the generic callback here would misclassify plugin tools as unknown admin tools.
    toolApproval: async () => "approved" as const,
    timeout: LEASH_AGENT_TIMEOUT,
    toolChoice: hasExecutableTools ? "auto" as const : "none" as const,
    stopWhen: isStepCount(hasExecutableTools ? stepBudget : 1),
    onStart: (event: { callId: string; modelId: string }) => recordAgentLifecycle(runtime, { event: "agent_start", callId: event.callId, modelId: event.modelId }),
    onStepStart: (event: { callId: string; modelId: string; stepNumber: number }) => recordAgentLifecycle(runtime, { event: "step_start", callId: event.callId, modelId: event.modelId, stepNumber: event.stepNumber }),
    onStepEnd: (event: { callId: string; stepNumber: number; finishReason: string }) => recordAgentLifecycle(runtime, { event: "step_end", callId: event.callId, stepNumber: event.stepNumber, finishReason: event.finishReason }),
    onEnd: (event: { callId: string; stepNumber: number; finishReason: string }) => recordAgentLifecycle(runtime, { event: "agent_end", callId: event.callId, stepNumber: event.stepNumber, finishReason: event.finishReason, durationMs: Date.now() - runtime.startedAt }),
  };
}

/**
 * DETERMINISTIC PIPELINE: run a step-declared skill one sub-task at a time, feeding each step's result
 * forward. The model never chooses whether to continue — the harness does. Each step is an isolated
 * `generateText` (fresh context → no overthinking accumulation), bounded to PIPELINE_STEP_BUDGET.
 */
async function runStepPipeline(skill: Skill, task: string, subTools: ToolSet, names: string[], goalRunId?: string): Promise<string> {
  const results: string[] = [];
  const executedByStep: string[][] = [];
  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i] as string;
    const prior = results.length
      ? `\n\nResults from earlier steps (use them — a later step often depends on what an earlier one returned):\n${results.map((r, j) => `· Step ${j + 1} (${skill.steps[j]}): ${r}`).join("\n")}`
      : "";
    const system = buildSkillStepSystemPrompt({ skillName: skill.name, skillBody: skill.body, task, step, index: i, total: skill.steps.length, prior });
    loopLog(`pipeline ${skill.slug} step ${i + 1}/${skill.steps.length}: ${step.slice(0, 60)}`);
    let ledgerStepId: string | undefined;
    const startedAt = Date.now();
    if (goalRunId) {
      const run = await getGoalRun(goalRunId);
      if (run) {
        const capsule = buildContextCapsule({ run, currentStep: step, relevantContext: [task], maxChars: 5000 });
        const ledgerStep = await startGoalRunStep(goalRunId, {
          title: step,
          route: "skill" satisfies GoalRunRoute,
          model: "chat",
          contextCapsule: capsule.text,
          contextTokensEstimate: capsule.tokenEstimate,
        });
        ledgerStepId = ledgerStep.id;
      }
    }
    try {
      // An author who names exactly one declared tool in a step is specifying an execution
      // invariant, not offering prose advice. Force that tool on the first loop step so a small
      // model cannot satisfy "Call foo" by hallucinating foo's result in text.
      const namedTools = names.filter((name) => new RegExp(`(?:^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_-])`, "i").test(step));
      // Prose steps use a forced typed submission instead of relying on fragile free text. Domain
      // tool steps retain the declared registry and force the author-named tool invariant.
      const stepNames = namedTools.length ? names : ["submit_step"];
      const stepTools = namedTools.length ? subTools : PIPELINE_OUTPUT_TOOLS;
      const base = subCallBase(
        `run_skill:${skill.slug}:step${i + 1}`,
        system,
        step,
        stepTools,
        stepNames,
        PIPELINE_STEP_BUDGET,
        createLeashRuntimeContext({ route: "skill", runId: goalRunId, stepId: ledgerStepId }),
      );
      const r = await generateText({
        ...base,
        // Pipeline decomposition is already deterministic; hidden deliberation only adds latency
        // and can consume the entire output budget before a forced call is serialized.
        providerOptions: qvacReasoningProviderOptions(false),
        maxOutputTokens: 320,
        toolChoice: namedTools.length === 1
          ? { type: "tool" as const, toolName: namedTools[0] as string }
          : namedTools.length === 0
            ? { type: "tool" as const, toolName: "submit_step" }
            : "auto" as const,
      });
      const modelSteps = (r as { steps?: Array<{ toolCalls?: Array<{ toolName?: string }>; toolResults?: Array<{ toolName?: string; output?: unknown }> }> }).steps ?? [];
      const executed = [...new Set(modelSteps.flatMap((modelStep) => (modelStep.toolCalls ?? []).map((call) => call.toolName).filter((name): name is string => !!name)))];
      if (namedTools.length === 1 && !executed.includes(namedTools[0] as string)) {
        throw new Error(`required pipeline tool ${namedTools[0]} did not execute in step ${i + 1}`);
      }
      const aggregateToolResults = [
        ...((r as { toolResults?: Array<{ toolName?: string; output?: unknown }> }).toolResults ?? []),
        ...modelSteps.flatMap((modelStep) => modelStep.toolResults ?? []),
      ];
      if (namedTools.length) {
        const calls = (r as { toolCalls?: Array<{ toolName?: string; input?: unknown }> }).toolCalls ?? [];
        loopLog(`pipeline ${skill.slug} tool evidence calls=${JSON.stringify(calls)} results=${JSON.stringify(aggregateToolResults)}`);
      }
      const requiredToolName = namedTools.length === 1 ? namedTools[0] : namedTools.length === 0 ? "submit_step" : undefined;
      const requiredToolResult = requiredToolName
        ? aggregateToolResults.find((result) => result.toolName === requiredToolName)
        : undefined;
      const requiredToolCall = requiredToolName
        ? ((r as { toolCalls?: Array<{ toolName?: string; input?: unknown }> }).toolCalls ?? []).find((call) => call.toolName === requiredToolName)
        : undefined;
      const submittedInputText = requiredToolName === "submit_step"
        ? (requiredToolCall?.input as { text?: unknown } | undefined)?.text
        : undefined;
      if (requiredToolName && requiredToolName !== "submit_step" && !requiredToolResult) {
        throw new Error(`required pipeline tool ${requiredToolName} returned no result in step ${i + 1}`);
      }
      const submittedText = requiredToolName === "submit_step"
        ? ((requiredToolResult?.output as { text?: unknown } | undefined)?.text ?? submittedInputText ?? submittedStepFromText(r.text))
        : undefined;
      if (requiredToolName === "submit_step" && (typeof submittedText !== "string" || !submittedText.trim())) {
        throw new Error(`required pipeline tool submit_step produced no text in step ${i + 1}`);
      }
      const out = typeof submittedText === "string" && submittedText.trim()
        ? submittedText.trim()
        : requiredToolResult
          ? `Deterministic ${requiredToolResult.toolName} result: ${JSON.stringify(requiredToolResult.output)}`
          : cleanPipelineText(r.text) || "(this step produced no user-facing text output)";
      results.push(out);
      executedByStep.push(executed.filter((name) => name !== "submit_step"));
      if (goalRunId && ledgerStepId) {
        await updateGoalRunStep(goalRunId, ledgerStepId, { status: "done", summary: out });
        await recordGoalRunModelTrace(goalRunId, {
          stepId: ledgerStepId,
          model: "chat",
          alias: `run_skill:${skill.slug}:step${i + 1}`,
          startedAt,
          finishedAt: Date.now(),
          tokens: ((r as { totalUsage?: { totalTokens?: number }; usage?: { totalTokens?: number } }).totalUsage?.totalTokens ?? (r as { usage?: { totalTokens?: number } }).usage?.totalTokens),
        });
      }
    } catch (e) {
      if (goalRunId && ledgerStepId) await updateGoalRunStep(goalRunId, ledgerStepId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
  // Hand the main assistant a compact, ordered digest of what the pipeline accomplished.
  return skill.steps.map((s, j) => `Step ${j + 1} — ${s}${executedByStep[j]?.length ? `\nTool executed: ${executedByStep[j]!.join(", ")}.` : ""}\n${results[j]}`).join("\n\n");
}

/**
 * Run a step-declared skill as a deterministic pipeline DIRECTLY (no model-side delegation) — the
 * chat route calls this when the matched active skill declares `steps:`, so a step-skill behaves as
 * a reliable multi-step WORKFLOW for the turn instead of being free-run by the 4B (which drops
 * dependent steps). Returns the same `{ text, sources }` shape run_skill produces. Loads the skill
 * by slug; returns an honest message if it's missing/disabled or has no steps.
 */
export async function runSkillAsPipeline(slug: string, task: string, registry: ToolSet, opts: { goalRunId?: string } = {}): Promise<{ text: string; sources: LeashSource[] }> {
  const s = await getSkill(slug.trim().toLowerCase());
  if (!s || !s.enabled) return { text: `No runnable skill named "${slug}".`, sources: [] };
  if (s.steps.length === 0) return { text: `The "${s.slug}" skill has no steps to run.`, sources: [] };
  const { subTools, names, skipped } = await subAgentTools(s, registry);
  const note = skipped.length ? ` (note: ${skipped.join(", ")} need approval and were skipped — invoke them on the main turn if needed.)` : "";
  try {
    const text = await runStepPipeline(s, task, subTools, names, opts.goalRunId);
    return { text: text + note, sources: [{ kind: "graph", title: `Skill · ${s.name}`, snippet: task.slice(0, 120) }] };
  } catch (e) {
    return { text: `The "${s.slug}" skill failed: ${e instanceof Error ? e.message : String(e)}`, sources: [] };
  }
}

/** Build the `run_skill` orchestration tool over the (raw) tool registry it delegates from. */
export function buildSkillRunner(registry: ToolSet): ToolSet {
  return {
    run_skill: tool({
      description:
        "Delegate a sub-task to ANOTHER of your skills. It runs that skill in its own focused context with its own tools and returns just the result — use it to orchestrate a multi-skill workflow (e.g. run the research skill, then act on what it returns). A skill may run as a single step or as a fixed multi-step pipeline; either way you make ONE call and get back the finished result. Pass the skill's slug and a clear, self-contained task.",
      inputSchema: z.object({
        skill: z.string().describe("The slug of the skill to run, exactly as listed in your prompt (e.g. 'deep-research')."),
        task: z.string().describe("The specific, self-contained task for that skill to carry out."),
      }),
      execute: async ({ skill, task }) => {
        const s = await getSkill(skill.trim().toLowerCase());
        if (!s || !s.enabled) return { text: `No runnable skill named "${skill}".`, sources: [] as LeashSource[] };

        const { subTools, names, skipped } = await subAgentTools(s, registry);
        const note = skipped.length ? ` (note: ${skipped.join(", ")} need approval and were skipped here — invoke them on the main turn if needed.)` : "";

        try {
          if (s.slug === "file-finder") {
            const fast = await runFileFinderFastPath(task, subTools);
            if (fast) {
              return { text: fast.text + note, sources: fast.sources as LeashSource[] };
            }
          }

          // DETERMINISTIC PIPELINE when the skill declares an ordered plan; else single-shot free-run.
          let text: string;
          if (s.steps.length > 0) {
            text = await runStepPipeline(s, task, subTools, names);
          } else {
            // No abortSignal + maxRetries 0 (qvac wedge rule — a retry re-pays a hung decode).
            const r = await generateText(
              subCallBase(
                `run_skill:${s.slug}`,
                buildSkillSubtaskSystemPrompt(s.name, s.body),
                task,
                subTools,
                names,
                SUB_STEPS,
              ),
            );
            text = r.text.trim() || `(the ${s.slug} skill returned no text)`;
          }
          return {
            text: text + note,
            sources: [{ kind: "graph", title: `Skill · ${s.name}`, snippet: task.slice(0, 120) }] as LeashSource[],
          };
        } catch (e) {
          return { text: `The "${s.slug}" skill failed: ${e instanceof Error ? e.message : String(e)}`, sources: [] as LeashSource[] };
        }
      },
    }),
  };
}
