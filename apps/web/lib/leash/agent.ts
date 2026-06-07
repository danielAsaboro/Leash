/**
 * The Leash agent (server-only) — `ToolLoopAgent` with type-safe call options.
 *
 * The chat route derives everything per turn (intent route, effort tier, assembled
 * system prompt) and passes it as CALL OPTIONS; `prepareCall` maps them onto agent
 * settings: which QVAC model drives, which tools are ACTIVE (the focused toolset),
 * the step budget, and the token ceiling. One agent per request — the tool registry
 * closes over the chat id (task/memory tools stamp their writes) so it can't be
 * module-level.
 *
 * INVARIANTS preserved from the hand-rolled route (do not regress):
 *   · NO abortSignal anywhere — `ToolLoopAgentSettings` omits it structurally and the
 *     route never passes one per-call (the qvac serve wedges on client aborts).
 *   · Toolless-hang guard: every text route keeps ≥1 active tool (qwen3-4b with
 *     `tools:true, toolsMode:"dynamic"` hangs at zero tokens on a toolless request).
 *     Only the `vision` route deactivates tools — qwen3vl is not tools-enabled.
 *   · Focused toolset: computer turns activate ONLY the six computer tools; other
 *     text turns activate everything BUT them (>22 schemas overflows the 4096-token
 *     prompt and hangs the decode — verified 2026-06-07).
 *   · `experimental_repairToolCall` keeps jsonrepair self-healing malformed calls.
 */
import "server-only";
import { ToolLoopAgent, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel, medpsyModel, visionModel, computerModel } from "./provider.ts";
import { repairLeashToolCall } from "./json-repair.ts";
import { computerTools } from "./computer-tools.ts";

/** Per-turn inputs the route derives server-side (validated by the agent at call time). */
export const leashCallOptionsSchema = z.object({
  /** Intent route — picks the driving QVAC model and the active toolset. */
  route: z.enum(["chat", "health", "computer", "vision"]),
  /** Step budget (`stopWhen`); null on vision turns (single-shot, no tool loop). */
  steps: z.number().int().min(1).max(16).nullable(),
  /** Token ceiling; null on vision turns (qwen3vl breaks on max_tokens — see computer-tools.ts). */
  maxOutputTokens: z.number().int().min(1).nullable(),
  /** The fully-assembled system prompt for this turn. */
  system: z.string(),
});
export type LeashCallOptions = z.infer<typeof leashCallOptionsSchema>;

const COMPUTER_NAMES = new Set(Object.keys(computerTools));

/**
 * Build the per-request agent over the gated+filtered registry. `prepareCall` does
 * the per-turn mapping the route used to inline around `streamText`.
 */
export function buildLeashAgent(tools: ToolSet): ToolLoopAgent<LeashCallOptions, ToolSet> {
  const names = Object.keys(tools);
  return new ToolLoopAgent<LeashCallOptions, ToolSet>({
    model: chatModel(), // default; prepareCall overrides per route
    tools,
    callOptionsSchema: leashCallOptionsSchema,
    experimental_repairToolCall: repairLeashToolCall,
    // NOTE: `...settings` is LOAD-BEARING — prepareCall's return carries the call's
    // prompt/messages forward (its return type is `Pick<Settings,…> & Omit<Prompt,…>`);
    // returning only overrides drops the messages → "prompt or messages must be
    // defined" (caught live 2026-06-07).
    prepareCall: ({ options, ...settings }) => ({
      ...settings,
      model: options.route === "vision" ? visionModel() : options.route === "computer" ? computerModel() : options.route === "health" ? medpsyModel() : chatModel(),
      instructions: options.system,
      // Focused toolset (see module header). Vision deactivates everything.
      activeTools:
        options.route === "vision" ? [] : names.filter((n) => COMPUTER_NAMES.has(n) === (options.route === "computer")),
      ...(options.steps !== null ? { stopWhen: stepCountIs(options.steps) } : {}),
      ...(options.maxOutputTokens !== null ? { maxOutputTokens: options.maxOutputTokens } : {}),
    }),
  });
}
