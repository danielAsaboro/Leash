import { COMPUTER_TOOL_NAMES, BASH_TOOL_NAMES, HEALTH_TOOL_NAMES, MCP_ADMIN_TOOL_NAMES } from "./tool-lane-names.ts";
import { KEEPALIVE_TOOL_NAME } from "./keepalive-tool.ts";
import { BROKER_TOOL_NAMES } from "./tool-brokers.ts";

export type ToolExposureRoute = "chat" | "health" | "computer" | "files" | "vision";

export interface ToolExposureOptions {
  route: ToolExposureRoute;
  skillTools?: string[];
  leanTools?: boolean;
}

/** A skill can't reintroduce the 4096-ctx overflow: its declared toolset is truncated here. */
export const SKILL_TOOLS_CAP = 18;

/**
 * Skill-system tools stay available when an active skill overrides the toolset, so a skill can
 * compose with another skill without pre-loading every skill body or every MCP schema.
 */
export const SKILL_SYSTEM_NAMES = new Set(["read_skill", "read_skill_file", "run_skill_script", "run_skill"]);

/**
 * Select the schemas a model should see for a single turn.
 *
 * This is intentionally pure: live policy filtering, user toggles, and approval gates happen before
 * this function. It only narrows the already-allowed registry to the lane-specific active set.
 */
export function resolveActiveToolNames(names: string[], options: ToolExposureOptions): string[] {
  if (options.route === "vision") return [];
  if (options.leanTools) return names.includes(KEEPALIVE_TOOL_NAME) ? [KEEPALIVE_TOOL_NAME] : names.slice(0, 1);

  const declared = options.skillTools ?? [];
  if (declared.length > 0) {
    let active = names.filter((n) => declared.includes(n) || SKILL_SYSTEM_NAMES.has(n));
    if (active.length > SKILL_TOOLS_CAP) active = active.slice(0, SKILL_TOOLS_CAP);
    if (active.length > 0) return active;
  }

  if (options.route === "files") return names.filter((n) => BASH_TOOL_NAMES.has(n));
  if (options.route === "computer") return names.filter((n) => COMPUTER_TOOL_NAMES.has(n));
  if (options.route === "health") return names.filter((n) => HEALTH_TOOL_NAMES.has(n));
  return names.filter((n) => (BROKER_TOOL_NAMES.has(n) && !MCP_ADMIN_TOOL_NAMES.has(n)) || SKILL_SYSTEM_NAMES.has(n));
}
