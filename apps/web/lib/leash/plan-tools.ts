/**
 * Plan mode (server-only) — the `submit_plan` tool + the deterministic plan executor.
 *
 * Plan mode turns the chat into PLAN-then-EXECUTE (Pre-Act): the model's only job in the planning
 * turn is to call `submit_plan` with an ordered list of atomic steps. The tool is approval-gated,
 * so the run PAUSES at the existing human-approval gate (the client renders a Plan card with
 * Approve / Reject / Adjust). On approval the SDK runs `execute`, which drives the steps through
 * the SAME deterministic pipeline that skill-`steps:` use — one atomic sub-task per step, prior
 * results fed forward — streaming each step's status as a persisted `data-plan` part. This places
 * the multi-step burden on the harness, not the 4B (which reliably does one atomic call but drops
 * dependent continuations — verified 2026-06-12), and reuses three things already proven in the
 * stack: the approval gate, deny-with-reason (= "adjust"), and the step pipeline.
 */
import "server-only";
import { tool, generateText, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { disabledTools, toolNeedsApproval } from "./tool-config.ts";
import { loopLog } from "./loop-diagnostics.ts";
import type { PlanData, PlanStep, PlanStepStatus } from "./types.ts";
import type { LeashSource } from "./tools.ts";
import { buildPlanStepSystemPrompt } from "./prompt.ts";
import { filterToolNamesForContext, enforceToolPolicy } from "@mycelium/leash-core/tool-policy";
import { buildContextCapsule } from "@mycelium/leash-core/context-capsule";
import { getGoalRun, startGoalRunStep, updateGoalRunStep, finishGoalRun, recordGoalRunModelTrace } from "@mycelium/leash-core/goal-runs";

/** Per-step budget inside the plan pipeline — each step is ONE bounded sub-task (tool → report). */
const PLAN_STEP_BUDGET = 3;
const MAX_PLAN_STEPS = 10;

/**
 * QVAC qwen3 is served with tools:true/toolsMode:dynamic. SDK 0.13.x rejects
 * requests with an empty tools array in that mode, so plan steps that have no
 * executable sub-tools still need one harmless schema.
 */
const KEEPALIVE_TOOLS: ToolSet = {
  note: tool({
    description: "Compatibility sentinel only. Do not call this tool; answer directly in text.",
    inputSchema: z.object({ note: z.string().describe("A short note.") }),
    execute: async ({ note }) => ({ noted: note }),
  }),
};

/** zod schema for the persisted `data-plan` part (validateUIMessages dataSchemas). */
export const planDataSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  status: z.enum(["proposed", "running", "done", "failed", "rejected"]),
  steps: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: z.enum(["pending", "active", "done", "failed", "skipped"]),
      note: z.string().optional(),
    }),
  ),
});

/** Resolve the executable subset of a registry: non-disabled, non-approval-gated, no run_skill/submit_plan
 *  (a non-streaming generateText step can't pause on an approval card, and plan steps don't re-plan). */
async function executableTools(registry: ToolSet, goalRunId?: string): Promise<{ subTools: ToolSet; names: string[] }> {
  const off = await disabledTools();
  const names: string[] = [];
  const policyAllowed = new Set(filterToolNamesForContext(Object.keys(registry), { route: "plan", ...(goalRunId ? { runId: goalRunId } : {}) }));
  for (const n of Object.keys(registry)) {
    if (!policyAllowed.has(n)) continue;
    if (n === "run_skill" || n === "submit_plan" || off.has(n)) continue;
    if (await toolNeedsApproval(n)) continue;
    names.push(n);
  }
  const raw = Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]]));
  return { subTools: enforceToolPolicy(raw, { route: "plan", ...(goalRunId ? { runId: goalRunId } : {}) }), names };
}

/** Per-step status callback — the route wires this to a `data-plan` writer for live UI updates. */
export type PlanProgress = (step: number, status: PlanStepStatus, note?: string) => void;

/**
 * Drive an arbitrary ordered plan as a deterministic pipeline: one atomic `generateText` per step
 * (fresh context, bounded), prior steps' results fed forward, `onStep` fired around each. Returns a
 * compact ordered digest of what the plan accomplished plus the per-step results.
 */
export async function runPlanAsPipeline(
  steps: string[],
  task: string,
  registry: ToolSet,
  onStep?: PlanProgress,
  shouldCancel?: () => boolean,
  opts: { goalRunId?: string; model?: string } = {},
): Promise<{ text: string; results: string[]; cancelled: boolean }> {
  const { subTools, names } = await executableTools(registry, opts.goalRunId);
  const results: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as string;
    // Cancellation checkpoint (between steps). A `generateText` mid-decode can't be aborted (qvac
    // wedge rule), but if the user stopped the turn we don't launch any more steps — mark this and
    // the rest skipped and return. This is what makes Stop actually stop a multi-step plan.
    if (shouldCancel?.()) {
      for (let j = i; j < steps.length; j++) onStep?.(j, "skipped", j === i ? "cancelled" : undefined);
      return { text: steps.slice(0, i).map((s, j) => `Step ${j + 1} — ${s}\n${results[j]}`).join("\n\n"), results, cancelled: true };
    }
    onStep?.(i, "active");
    const prior = results.length
      ? `\n\nResults from earlier steps (use them — a later step often depends on what an earlier one returned):\n${results.map((r, j) => `· Step ${j + 1} (${steps[j]}): ${r}`).join("\n")}`
      : "";
    const system = buildPlanStepSystemPrompt({ task, step, index: i, total: steps.length, prior });
    loopLog(`plan step ${i + 1}/${steps.length}: ${step.slice(0, 60)}`);
    let ledgerStepId: string | undefined;
    const startedAt = Date.now();
    if (opts.goalRunId) {
      const run = await getGoalRun(opts.goalRunId);
      if (run) {
        const capsule = buildContextCapsule({ run, currentStep: step, relevantContext: [task], maxChars: 5000 });
        const ledgerStep = await startGoalRunStep(opts.goalRunId, {
          title: step,
          route: "plan",
          ...(opts.model ? { model: opts.model } : {}),
          contextCapsule: capsule.text,
          contextTokensEstimate: capsule.tokenEstimate,
        });
        ledgerStepId = ledgerStep.id;
      }
    }
    try {
      // qvac wedge rule: no abortSignal, maxRetries 0 (a retry re-pays a hung decode).
      const hasExecutableTools = names.length > 0;
      const runSystem = hasExecutableTools
        ? system
        : `${system}\n\nNo executable tools are available in this plan step. Answer directly in plain text. Do not call tools.`;
      const r = await generateText({
        model: chatModel(`plan:step${i + 1}`),
        system: runSystem,
        messages: [{ role: "user" as const, content: step }],
        temperature: 0.6,
        topP: 0.95,
        maxRetries: 0,
        maxOutputTokens: hasExecutableTools ? 900 : 220,
        tools: hasExecutableTools ? subTools : KEEPALIVE_TOOLS,
        toolChoice: hasExecutableTools ? "auto" : "none",
        stopWhen: stepCountIs(hasExecutableTools ? PLAN_STEP_BUDGET : 1),
      });
      const out = r.text.trim() || "(this step produced no text output)";
      results.push(out);
      onStep?.(i, "done", out.length > 160 ? out.slice(0, 157) + "…" : out);
      if (opts.goalRunId && ledgerStepId) {
        await updateGoalRunStep(opts.goalRunId, ledgerStepId, { status: "done", summary: out });
        await recordGoalRunModelTrace(opts.goalRunId, {
          stepId: ledgerStepId,
          model: opts.model ?? "chat",
          alias: `plan:step${i + 1}`,
          startedAt,
          finishedAt: Date.now(),
          tokens: ((r as { totalUsage?: { totalTokens?: number }; usage?: { totalTokens?: number } }).totalUsage?.totalTokens ?? (r as { usage?: { totalTokens?: number } }).usage?.totalTokens),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onStep?.(i, "failed", msg);
      if (opts.goalRunId && ledgerStepId) await updateGoalRunStep(opts.goalRunId, ledgerStepId, { status: "failed", error: msg });
      // Mark the remaining steps skipped and stop the plan.
      for (let j = i + 1; j < steps.length; j++) onStep?.(j, "skipped");
      throw new Error(`step ${i + 1} ("${step}") failed: ${msg}`);
    }
  }
  return { text: steps.map((s, j) => `Step ${j + 1} — ${s}\n${results[j]}`).join("\n\n"), results, cancelled: false };
}

/** Build an empty/proposed PlanData from a step list (the shape the client renders for approval). */
export function proposedPlan(id: string, title: string | undefined, steps: string[]): PlanData {
  const planSteps: PlanStep[] = steps.map((text, i) => ({ id: `${id}-s${i}`, text, status: "pending" }));
  return { id, ...(title ? { title } : {}), status: "proposed", steps: planSteps };
}

export interface PlanToolDeps {
  /** The full tool registry the approved steps execute against. */
  registry: ToolSet;
  /** Returns the user's task for this turn — a getter, since the tool is built (for validation)
   *  before the task text is resolved. Fed to each step as overall context. */
  getTask: () => string;
  /** Returns the live UIMessage stream writer, set once the response stream opens (for data-plan). */
  getWriter: () => { write: (part: unknown) => void } | undefined;
  /** True once the turn should stop (client stopped/disconnected, OR a follow-up is waiting to
   *  interject) — checked BETWEEN steps to halt the plan after the current one. */
  getAbort: () => boolean;
  /** A stable id for this turn's plan (so the proposed card and the executing part reconcile). */
  planId: string;
  /** Stable id of the durable run this plan belongs to. */
  getRunId?: () => string | undefined;
  /** Model alias selected for this turn, for ledger telemetry. */
  getModel?: () => string | undefined;
}

/**
 * The `submit_plan` tool (approval-gated). The model calls it with the ordered steps; the run pauses
 * at the approval gate. On approval, `execute` runs the steps through the deterministic pipeline,
 * streaming a reconciled `data-plan` part as it goes, and returns the synthesized result text.
 */
export function buildPlanTool({ registry, getTask, getWriter, getAbort, planId, getRunId, getModel }: PlanToolDeps): ToolSet {
  return {
    submit_plan: tool({
      description:
        "Draft an ordered plan for the user's request as a list of ATOMIC steps (each one a single, self-contained sub-task — e.g. 'search the notes for X', 'create a task to Y'). Call this FIRST, before doing anything else. The user reviews and approves the plan; then each step runs in order. Keep it to the fewest steps that actually accomplish the task.",
      inputSchema: z.object({
        title: z.string().optional().describe("A short title for the plan (e.g. 'Summarize and file the meeting notes')."),
        steps: z.array(z.string()).min(1).max(MAX_PLAN_STEPS).describe("The ordered atomic steps, one sub-task each."),
      }),
      // needsApproval → the run pauses at the human-approval gate; the client renders the Plan card.
      needsApproval: true,
      execute: async ({ title, steps }) => {
        const writer = getWriter();
        const task = getTask();
        const planSteps: PlanStep[] = steps.map((text, i) => ({ id: `${planId}-s${i}`, text, status: "pending" as PlanStepStatus }));
        const emit = (status: PlanData["status"]) => {
          writer?.write({ type: "data-plan", id: planId, data: { id: planId, ...(title ? { title } : {}), status, steps: planSteps } satisfies PlanData });
        };
        emit("running");
        try {
          const out = await runPlanAsPipeline(
            steps,
            task,
            registry,
            (i, status, note) => {
              const s = planSteps[i];
              if (s) {
                s.status = status;
                if (note) s.note = note;
              }
              emit("running");
            },
            getAbort,
            { goalRunId: getRunId?.(), model: getModel?.() },
          );
          emit(out.cancelled ? "failed" : "done");
          if (getRunId?.()) await finishGoalRun(getRunId()!, out.cancelled ? "cancelled" : "completed", out.text);
          return {
            text: out.cancelled ? `Plan cancelled after ${out.results.length} of ${steps.length} step(s).\n\n${out.text}` : out.text,
            sources: [{ kind: "graph", title: "Plan", snippet: task.slice(0, 120) }] as LeashSource[],
          };
        } catch (e) {
          emit("failed");
          if (getRunId?.()) await finishGoalRun(getRunId()!, "failed", e instanceof Error ? e.message : String(e));
          return { text: `The plan stopped: ${e instanceof Error ? e.message : String(e)}`, sources: [] as LeashSource[] };
        }
      },
    }),
  };
}
