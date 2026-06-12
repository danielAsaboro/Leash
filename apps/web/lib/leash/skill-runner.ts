/**
 * Skill orchestration (server-only) — the `run_skill` tool: delegate a sub-task to ANOTHER skill,
 * which runs as a SUB-AGENT in its own focused context with its own tools and returns just the
 * result. This is what makes multi-skill workflows work WITHOUT bloating the parent's context:
 * the parent keeps one active skill (lean), and reaches for others on demand. It also gives the
 * model a REAL tool to invoke another skill — instead of emitting `<tool_call>` text for a skill
 * whose tools aren't loaded (the within-turn-orchestration failure the forgiving-parser detector caught).
 *
 * The sub-agent gets the skill's declared tools MINUS any that are approval-gated or disabled — a
 * non-streaming `generateText` can't pause on a human approval card, so side-effectful actions
 * (run_command, ha_call_service, installs) stay on the main turn. Sub-agents don't nest (no run_skill).
 */
import "server-only";
import { tool, generateText, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel } from "./provider.ts";
import { getSkill } from "./skills-store.ts";
import { toolNeedsApproval, disabledTools } from "./tool-config.ts";
import type { LeashSource } from "./tools.ts";

/** Step budget for a delegated sub-skill (its own small tool loop). */
const SUB_STEPS = 6;

/** Build the `run_skill` orchestration tool over the (raw) tool registry it delegates from. */
export function buildSkillRunner(registry: ToolSet): ToolSet {
  return {
    run_skill: tool({
      description:
        "Delegate a sub-task to ANOTHER of your skills. It runs that skill in its own focused context with its own tools and returns just the result — use it to orchestrate a multi-skill workflow (e.g. run the research skill, then act on what it returns). Pass the skill's slug and a clear, self-contained sub-task.",
      inputSchema: z.object({
        skill: z.string().describe("The slug of the skill to run, exactly as listed in your prompt (e.g. 'deep-research')."),
        task: z.string().describe("The specific, self-contained sub-task for that skill to carry out."),
      }),
      execute: async ({ skill, task }) => {
        const s = await getSkill(skill.trim().toLowerCase());
        if (!s || !s.enabled) return { text: `No runnable skill named "${skill}".`, sources: [] as LeashSource[] };

        // Sub-agent toolset: the skill's declared tools that exist, aren't disabled, aren't approval-
        // gated, and aren't run_skill itself (no nesting). Gated/action tools stay on the main turn.
        const off = await disabledTools();
        const names: string[] = [];
        const skipped: string[] = [];
        for (const n of s.tools) {
          if (n === "run_skill" || !registry[n] || off.has(n)) continue;
          if (await toolNeedsApproval(n)) {
            skipped.push(n);
            continue;
          }
          names.push(n);
        }
        const subTools: ToolSet = Object.fromEntries(names.map((n) => [n, registry[n] as ToolSet[string]]));

        try {
          // No abortSignal + maxRetries 0 (qvac wedge rule — a retry re-pays a hung decode).
          const r = await generateText({
            model: chatModel(),
            system: `You are running the "${s.name}" skill as a focused sub-task for the main assistant. Follow these instructions, use your tools, and return a concise result the main assistant can use directly.\n\n${s.body}`,
            messages: [{ role: "user", content: task }],
            temperature: 0.6,
            topP: 0.95,
            maxRetries: 0,
            ...(names.length ? { tools: subTools, stopWhen: stepCountIs(SUB_STEPS) } : {}),
          });
          const note = skipped.length ? ` (note: ${skipped.join(", ")} need approval and were skipped here — invoke them on the main turn if needed.)` : "";
          return {
            text: (r.text.trim() || `(the ${s.slug} skill returned no text)`) + note,
            sources: [{ kind: "graph", title: `Skill · ${s.name}`, snippet: task.slice(0, 120) }] as LeashSource[],
          };
        } catch (e) {
          return { text: `The "${s.slug}" skill failed: ${e instanceof Error ? e.message : String(e)}`, sources: [] as LeashSource[] };
        }
      },
    }),
  };
}
