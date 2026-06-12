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
import { ToolLoopAgent, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { chatModel, medpsyModel, visionModel, computerModel } from "./provider.ts";
import { repairLeashToolCall } from "./json-repair.ts";
import { computerTools } from "./computer-tools.ts";
import { BASH_TOOL_NAMES } from "./bash-tools.ts";
import { MCP_ADMIN_TOOL_NAMES } from "./mcp-admin-tools.ts";

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
  /** The fully-assembled system prompt for this turn. */
  system: z.string(),
});
export type LeashCallOptions = z.infer<typeof leashCallOptionsSchema>;

const COMPUTER_NAMES = new Set(Object.keys(computerTools));

/**
 * Skill-system tools — kept available even when an active skill overrides the toolset, so a
 * skill can COMPOSE: load another skill (read_skill), read a skill's reference (read_skill_file),
 * or run a skill's bundled script (run_skill_script) mid-turn. This is what lets one active skill
 * reach for another instead of the harness pre-loading them all.
 */
const SKILL_SYSTEM_NAMES = new Set(["read_skill", "read_skill_file", "run_skill_script"]);

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
  if (options.route === "computer") return names.filter((n) => COMPUTER_NAMES.has(n));
  return names.filter((n) => !COMPUTER_NAMES.has(n) && !MCP_ADMIN_TOOL_NAMES.has(n));
}

/** Schema-count guard (LEASH_DEBUG_TOOLS=1): log the active toolset so a route can be checked against the ~22-schema cap. */
function debugActiveTools(route: string, active: string[]): void {
  if (process.env["LEASH_DEBUG_TOOLS"]) console.log(`leash[tools] route=${route} active=${active.length} [${active.join(", ")}]`);
}

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
    prepareCall: ({ options, ...settings }) => {
      const activeTools = resolveActiveTools(names, options);
      debugActiveTools(options.route, activeTools);
      return {
        ...settings,
        model: options.route === "vision" ? visionModel() : options.route === "computer" ? computerModel() : options.route === "health" ? medpsyModel() : chatModel(),
        instructions: options.system,
        activeTools,
        ...(options.steps !== null ? { stopWhen: stepCountIs(options.steps) } : {}),
        ...(options.maxOutputTokens !== null ? { maxOutputTokens: options.maxOutputTokens } : {}),
      };
    },
  });
}
