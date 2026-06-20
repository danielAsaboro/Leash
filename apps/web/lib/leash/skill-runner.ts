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
 *     This is the fix for qwen3-4b's dependent-step / Implicit-Action failure (verified 2026-06-12:
 *     the 4B reliably does ONE sub-task and fires parallel calls, but drops the dependent NEXT call at
 *     the continuation boundary — and a scratchpad nudge, though confirmed-injected, did NOT fix it).
 *     Moving the step-ordering decision OUT of the model and INTO the harness is the deep-research-
 *     recommended placement of the planning burden for a small model (author-time, not model-time).
 *
 * The sub-agent gets the skill's declared tools MINUS any that are approval-gated or disabled — a
 * non-streaming `generateText` can't pause on a human approval card, so side-effectful actions
 * (run_command, ha_call_service, installs) stay on the main turn. Sub-agents don't nest (no run_skill).
 */
import "server-only";
import { tool, generateText, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { getSkill, type Skill } from "./skills-store.ts";
import { toolNeedsApproval, disabledTools } from "./tool-config.ts";
import { loopLog } from "./loop-diagnostics.ts";
import type { LeashSource } from "./tools.ts";
import { buildSkillStepSystemPrompt, buildSkillSubtaskSystemPrompt } from "./prompt.ts";
import { enforceToolPolicy, filterToolNamesForContext } from "@mycelium/leash-core/tool-policy";
import { buildContextCapsule } from "@mycelium/leash-core/context-capsule";
import { getGoalRun, startGoalRunStep, updateGoalRunStep, recordGoalRunModelTrace, type GoalRunRoute } from "@mycelium/leash-core/goal-runs";

/** Step budget for a single-shot delegated sub-skill (its own small tool loop). */
const SUB_STEPS = 6;
/** Per-step budget inside a deterministic pipeline — each step is ONE bounded sub-task (tool → report). */
const PIPELINE_STEP_BUDGET = 3;

/** Resolve the sub-agent toolset for a skill: declared tools that exist, aren't disabled/approval-gated,
 *  and aren't run_skill (no nesting). Returns the live ToolSet plus the names skipped for approval. */
async function subAgentTools(skill: Skill, registry: ToolSet): Promise<{ subTools: ToolSet; names: string[]; skipped: string[] }> {
  const off = await disabledTools();
  const names: string[] = [];
  const skipped: string[] = [];
  const policyAllowed = new Set(filterToolNamesForContext(skill.tools, { route: "skill", subagent: true }));
  for (const n of skill.tools) {
    if (!policyAllowed.has(n)) continue;
    if (n === "run_skill" || !registry[n] || off.has(n)) continue;
    if (await toolNeedsApproval(n)) {
      skipped.push(n);
      continue;
    }
    names.push(n);
  }
  const subTools: ToolSet = enforceToolPolicy(Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]])), { route: "skill", subagent: true });
  return { subTools, names, skipped };
}

/** Common generateText settings for a sub-skill call (qvac wedge rule: no abortSignal, maxRetries 0). */
function subCallBase(label: string, system: string, userContent: string, subTools: ToolSet, names: string[], stepBudget: number) {
  return {
    model: chatModel(label),
    system,
    messages: [{ role: "user" as const, content: userContent }],
    temperature: 0.6,
    topP: 0.95,
    maxRetries: 0,
    ...(names.length ? { tools: subTools, stopWhen: stepCountIs(stepBudget) } : {}),
  };
}

/**
 * DETERMINISTIC PIPELINE: run a step-declared skill one sub-task at a time, feeding each step's result
 * forward. The model never chooses whether to continue — the harness does. Each step is an isolated
 * `generateText` (fresh context → no overthinking accumulation), bounded to PIPELINE_STEP_BUDGET.
 */
async function runStepPipeline(skill: Skill, task: string, subTools: ToolSet, names: string[], goalRunId?: string): Promise<string> {
  const results: string[] = [];
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
          model: "qwen3-4b",
          contextCapsule: capsule.text,
          contextTokensEstimate: capsule.tokenEstimate,
        });
        ledgerStepId = ledgerStep.id;
      }
    }
    try {
      const r = await generateText(subCallBase(`run_skill:${skill.slug}:step${i + 1}`, system, step, subTools, names, PIPELINE_STEP_BUDGET));
      const out = r.text.trim() || "(this step produced no text output)";
      results.push(out);
      if (goalRunId && ledgerStepId) {
        await updateGoalRunStep(goalRunId, ledgerStepId, { status: "done", summary: out });
        await recordGoalRunModelTrace(goalRunId, {
          stepId: ledgerStepId,
          model: "qwen3-4b",
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
  return skill.steps.map((s, j) => `Step ${j + 1} — ${s}\n${results[j]}`).join("\n\n");
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
