/**
 * The on-device Leash agent — the RN port of `apps/web/lib/leash/agent.ts` `buildLeashAgent`.
 *
 * Pared down for the phone: the web version carries route lanes (chat/health/computer/files/vision),
 * a disk-backed continuation-nudge, and skill-tool gating. On-device we keep the essence — a
 * single-use `ToolLoopAgent` that wraps a model + tool registry + a per-turn system prompt and runs
 * the multi-step tool loop until `stopWhen`. Node-only bits (`server-only`, `node:fs`/`node:path`
 * continuation flag, `process.env` debug) are dropped; everything here is pure-TS and bundles into
 * the app (mobile is workspace-excluded — see CLAUDE.md).
 */
import { ToolLoopAgent, stepCountIs, type LanguageModel, type ToolSet } from "ai";

/** Per-turn shape the chat transport assembles before each send. */
export type LeashTurn = {
  /** The on-device (or, post-Stage-3, borrowed) chat model — already reasoning-wrapped. */
  model: LanguageModel;
  /** The fully-composed system prompt (identity + soul/goals + memories + skill body + notes). */
  system: string;
  /** Active tool registry for this turn (empty/undefined for plain chat or mesh-borrow). */
  tools?: ToolSet;
  /** Max LLM steps in the tool loop. Defaults to 8; plain chat collapses to 1 step naturally. */
  maxSteps?: number;
};

/**
 * Assemble a single-use `ToolLoopAgent` for one turn. Mirrors the web `buildLeashAgent` contract
 * (model + tools + instructions + stopWhen) so the loop semantics match: the model may call tools,
 * tool outputs feed the next step, and the turn ends when the model answers without a tool call or
 * the step cap is hit.
 */
export function buildLeashAgent(turn: LeashTurn): ToolLoopAgent<never, ToolSet> {
  const tools = turn.tools ?? {};
  const hasTools = Object.keys(tools).length > 0;
  return new ToolLoopAgent<never, ToolSet>({
    model: turn.model,
    instructions: turn.system,
    tools,
    // A no-tools turn never loops; cap at 1 so the SDK doesn't reserve extra steps. With tools,
    // allow the multi-step loop up to the configured ceiling.
    stopWhen: stepCountIs(hasTools ? (turn.maxSteps ?? 8) : 1),
  });
}
