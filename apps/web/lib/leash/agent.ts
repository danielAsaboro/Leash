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
 *   · Focused toolset: computer turns activate ONLY the computer tools; other text turns
 *     activate everything BUT them (>22 schemas overflows the 4096-token prompt and hangs
 *     the decode — verified 2026-06-07). MCP-admin tools are SKILL-GATED (never always-on).
 *   · Progressive tool disclosure: when an ACTIVE skill declares `tools:` (skillTools),
 *     that set OVERRIDES the route's default toolset — the skill becomes the primary lane,
 *     route selection the fallback. Capped + ≥1-tool guarded so a skill can't reintroduce
 *     the overflow or trip the toolless-hang.
 *   · `experimental_repairToolCall` keeps jsonrepair self-healing malformed calls.
 */
import "server-only";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ToolLoopAgent, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel, medpsyModel, visionModel, computerModel } from "./provider.ts";
import { repairLeashToolCall } from "./json-repair.ts";
import { DATA_DIR } from "./json-store.ts";
import { loopLog } from "./loop-diagnostics.ts";
import { COMPUTER_TOOL_NAMES, BASH_TOOL_NAMES, MCP_ADMIN_TOOL_NAMES } from "./tool-lanes.ts";

/** A skill can't reintroduce the 4096-ctx overflow: its declared toolset is truncated here. */
const SKILL_TOOLS_CAP = 18;

/** Per-turn inputs the route derives server-side (validated by the agent at call time). */
export const leashCallOptionsSchema = z.object({
  /** Intent route — picks the driving QVAC model and the DEFAULT toolset (skillTools can override). */
  route: z.enum(["chat", "health", "computer", "files", "vision"]),
  /** Step budget (`stopWhen`); null on vision turns (single-shot, no tool loop). */
  steps: z.number().int().min(1).max(16).nullable(),
  /** Token ceiling; null on vision turns (qwen3vl breaks on max_tokens — see computer-tools.ts). */
  maxOutputTokens: z.number().int().min(1).nullable(),
  /**
   * Tools an ACTIVE skill declared (frontmatter `tools:`). When non-empty, these become the
   * EXACT active toolset for this turn (intersected with the live registry), overriding the
   * route branch. Empty = use the route default. Never applied on the tool-less vision route.
   */
  skillTools: z.array(z.string()).optional(),
  /**
   * Whether `<think>` reasoning is ON for this turn (deep text). Drives sampling per Qwen3's
   * best practices: thinking → temp 0.6 / topP 0.95; non-thinking (/no_think) → temp 0.7 / topP 0.8
   * The serve's default (temp ~0.1, near-greedy) is exactly what Qwen warns AGAINST
   * — "performance degradation and endless repetitions". Absent on vision (single-shot, own model).
   */
  thinking: z.boolean().optional(),
  /** The fully-assembled system prompt for this turn. */
  system: z.string(),
});
export type LeashCallOptions = z.infer<typeof leashCallOptionsSchema>;

/** Qwen3 sampling per thinking mode (Qwen3 best practices). `topK` is omitted: the qvac/qwen3-4b
 *  provider doesn't support it (it dropped the value and logged an AI SDK warning every turn). */
function samplingFor(thinking: boolean | undefined): { temperature: number; topP: number } {
  return thinking ? { temperature: 0.6, topP: 0.95 } : { temperature: 0.7, topP: 0.8 };
}

/**
 * Skill-system tools — kept available even when an active skill overrides the toolset, so a
 * skill can COMPOSE: load another skill (read_skill), read a skill's reference (read_skill_file),
 * or run a skill's bundled script (run_skill_script) mid-turn. This is what lets one active skill
 * reach for another instead of the harness pre-loading them all.
 */
const SKILL_SYSTEM_NAMES = new Set(["read_skill", "read_skill_file", "run_skill_script", "run_skill"]);

/**
 * The ACTIVE toolset for a turn, over the live (gated+filtered) registry `names`.
 *
 * Precedence:
 *   1. vision → no tools (qwen3vl isn't tools-enabled).
 *   2. An ACTIVE skill's declared `tools:` (skillTools) → EXACTLY those names that exist in
 *      the registry, capped at SKILL_TOOLS_CAP (log + truncate so a skill can't re-overflow
 *      the 4096-ctx prompt). If that intersection is empty (all disabled/unknown) we ignore
 *      it and fall through to the route default — never ship a tool-less request (hang guard).
 *   3. route default: `computer`/`files` lanes narrow to their own group; every other text
 *      turn gets everything BUT the computer tools and the SKILL-GATED MCP-admin tools (so
 *      MCP costs 0 always-on schema slots until its skill activates). `bash` (read-only) is
 *      always-on — the shell is the default executor for time/file reads.
 */
function resolveActiveTools(names: string[], options: LeashCallOptions): string[] {
  if (options.route === "vision") return [];

  const declared = options.skillTools ?? [];
  if (declared.length > 0) {
    // The skill's declared tools PLUS the always-available skill-system tools (so it can compose
    // by loading another skill mid-turn). De-duped, capped to stay bounded.
    let active = names.filter((n) => declared.includes(n) || SKILL_SYSTEM_NAMES.has(n));
    if (active.length > SKILL_TOOLS_CAP) {
      console.warn(`leash: skill declared ${active.length} tools (> cap ${SKILL_TOOLS_CAP}) — truncating: dropped ${active.slice(SKILL_TOOLS_CAP).join(", ")}`);
      active = active.slice(0, SKILL_TOOLS_CAP);
    }
    if (active.length > 0) return active; // else fall through (no live tools matched)
  }

  if (options.route === "files") return names.filter((n) => BASH_TOOL_NAMES.has(n));
  if (options.route === "computer") return names.filter((n) => COMPUTER_TOOL_NAMES.has(n));
  return names.filter((n) => !COMPUTER_TOOL_NAMES.has(n) && !MCP_ADMIN_TOOL_NAMES.has(n));
}

/** Schema-count guard (LEASH_DEBUG_TOOLS=1): log the active toolset so a route can be checked against the ~22-schema cap. */
function debugActiveTools(route: string, active: string[]): void {
  if (process.env["LEASH_DEBUG_TOOLS"]) console.log(`leash[tools] route=${route} active=${active.length} [${active.join(", ")}]`);
}

/** On-switch file flag (re-checked per call, so a running dev server can A/B without a restart). */
const NUDGE_ON_FILE = join(DATA_DIR, ".leash-continuation");
/**
 * Continuation re-injection — DEFAULT OFF. Tested 2026-06-12 against qwen3-4b and found to give NO
 * measurable benefit on dependent-step chaining: with LEASH_DEBUG_LOOP we confirmed the nudge WAS
 * injected (`nudge-injected step=N` in the loop log) yet the model still overthought (1217 chars of
 * reasoning) and stopped with no action — ON ≈ 1/5 vs OFF ≈ 1/3 dependent-chain completions, i.e.
 * within noise. This matches the deep-research finding that no prompting/scaffold win has been isolated
 * at the 4B scale without a fine-tune. The mechanism + prepareStep hook are kept flag-gated for future
 * experiments (e.g. plan-then-execute / deterministic decomposition), enabled via LEASH_CONTINUATION_NUDGE=1
 * or a `data/.leash-continuation` file. Do NOT enable in prod expecting it to fix C — it doesn't.
 */
function continuationOn(): boolean {
  if (process.env["LEASH_CONTINUATION_NUDGE"] === "1" || process.env["LEASH_CONTINUATION_NUDGE"] === "true") return true;
  try {
    return existsSync(NUDGE_ON_FILE);
  } catch {
    return false;
  }
}

/**
 * Scratchpad re-injection — the diagnosed fix for failure mode "C — dependent-step / Implicit Action
 * Failure": after a tool returns, qwen3-4b re-decides at the continuation boundary and writes a final
 * answer instead of firing the dependent NEXT call, even when the user's request explicitly named it.
 * (Verified 2026-06-12 with loop-diagnostics: independent calls fire fine in ONE parallel step; only the
 * RESULT-DEPENDENT next step gets dropped — `finish=stop, toolCalls=0` — amplified by overthinking,
 * `reasoning=3442` vs a 112-char answer.)
 *
 * Before every step after the first, we re-state the goal and keep a running scratchpad of the tools
 * already run, with an explicit stop rule: only answer once EVERY part of the request is done. This keeps
 * the goal salient (counters C) and replaces open-ended deliberation with a checklist decision (counters
 * the overthinking that ends in "just answer"). It never FORCES a call — the model may still stop when
 * genuinely done — and `stopWhen: stepCountIs(...)` still bounds the loop.
 */
function continuationNudge(steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }>): string {
  const ran = [...new Set(steps.flatMap((s) => (s.toolCalls ?? []).map((c) => c.toolName).filter((n): n is string => !!n)))];
  const progress = ran.length ? `Tools you have already run this turn: ${ran.join(", ")}.` : "You have not run any tool yet this turn.";
  return (
    `[continuing — step ${steps.length + 1}] You are in the MIDDLE of the user's request, not at the end. ${progress} ` +
    `Re-read their original request above and check it part by part: if ANY part is not yet done, call the right tool NOW instead of replying. ` +
    `A later step may depend on what an earlier tool returned — use that result to do the next part. ` +
    `Only write your final answer once EVERY part of the request is complete.`
  );
}

/**
 * Build the per-request agent over the gated+filtered registry. `prepareCall` does
 * the per-turn mapping the route used to inline around `streamText`.
 */
export function buildLeashAgent(tools: ToolSet, shouldYield?: () => boolean): ToolLoopAgent<LeashCallOptions, ToolSet> {
  const names = Object.keys(tools);
  // Per-request closure: the call's assembled system prompt, captured in prepareCall so prepareStep can
  // re-emit it (prepareStep's `system` override REPLACES the system for that step — we must re-include
  // the base or the model loses its whole prompt mid-loop). One agent per request ⇒ no cross-request bleed.
  let currentSystem = "";
  let currentRoute: LeashCallOptions["route"] = "chat";
  return new ToolLoopAgent<LeashCallOptions, ToolSet>({
    model: chatModel(), // default; prepareCall overrides per route
    tools,
    callOptionsSchema: leashCallOptionsSchema,
    experimental_repairToolCall: repairLeashToolCall,
    // NOTE: `...settings` is LOAD-BEARING — prepareCall's return carries the call's
    // prompt/messages forward (its return type is `Pick<Settings,…> & Omit<Prompt,…>`);
    // returning only overrides drops the messages → "prompt or messages must be
    // defined" (caught live 2026-06-07).
    prepareCall: ({ options, ...settings }) => {
      const activeTools = resolveActiveTools(names, options);
      debugActiveTools(options.route, activeTools);
      currentSystem = options.system;
      currentRoute = options.route;
      return {
        ...settings,
        model: options.route === "vision" ? visionModel() : options.route === "computer" ? computerModel() : options.route === "health" ? medpsyModel() : chatModel(),
        instructions: options.system,
        activeTools,
        // Qwen3 sampling — NEVER greedy (the serve default temp ~0.1 causes repetition/loops). Vision
        // (qwen3vl, single-shot) keeps its own behavior; every text/tool route gets proper sampling.
        ...(options.route !== "vision" ? samplingFor(options.thinking) : {}),
        // Stop on the step cap OR when the user has a follow-up waiting (interject): the loop ends
        // after the current step, the turn finishes cleanly, and the client sends the queued message.
        ...(options.steps !== null ? { stopWhen: [stepCountIs(options.steps), ...(shouldYield ? [() => shouldYield()] : [])] } : {}),
        ...(options.maxOutputTokens !== null ? { maxOutputTokens: options.maxOutputTokens } : {}),
      };
    },
    // Scratchpad re-injection on continuation steps (see continuationNudge). Skipped on the first step
    // (the original system already carries the goal) and on vision (single-shot, no loop). Returning
    // `system` here OVERRIDES it for the step, so we re-include `currentSystem` + the nudge.
    prepareStep: ({ stepNumber, steps }) => {
      if (stepNumber < 1 || currentRoute === "vision" || !continuationOn()) return {};
      loopLog(`nudge-injected step=${stepNumber}`); // visible only with LEASH_DEBUG_LOOP — proves the override fired
      return { system: `${currentSystem} ${continuationNudge(steps)}` };
    },
  });
}
