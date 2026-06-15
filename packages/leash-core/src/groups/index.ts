/**
 * The tool-group registry — the single list that drives the `leash-tools-mcp` daemon's
 * route table AND the web's built-in MCP server entries. Adding a capability is: write a
 * `groups/<name>.ts` exporting a `ToolGroup`, then append it here. Nothing else changes —
 * the daemon mounts it on `/mcp/<id>` and the dashboard shows a new toggle.
 */
import { homeAssistantGroup } from "./home-assistant.ts";
import { feedGroup } from "./feed.ts";
import { memoryGroup } from "./memory.ts";
import { tasksGroup } from "./tasks.ts";
import { contextGroup } from "./context.ts";
import { photosGroup } from "./photos.ts";
import { imageGroup } from "./image.ts";
import { researchGroup } from "./research.ts";
import { skillsGroup } from "./skills.ts";
import { computerGroup } from "./computer.ts";
import { filesGroup } from "./files.ts";
import { mcpAdminGroup } from "./mcp-admin.ts";
import { schedulerGroup } from "./scheduler.ts";
import type { ToolGroup, GroupTool } from "./types.ts";

export type { ToolGroup, GroupTool } from "./types.ts";

/** Every tool group, in display order. */
export const TOOL_GROUPS: ToolGroup[] = [homeAssistantGroup, feedGroup, memoryGroup, tasksGroup, contextGroup, photosGroup, imageGroup, researchGroup, skillsGroup, computerGroup, filesGroup, mcpAdminGroup, schedulerGroup];

/** Look up a group by its id (URL path segment). */
export function groupById(id: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((g) => g.id === id);
}

/** Tool names that default to "Ask first" (a human approval card) — surfaced to the web's tool-config. */
export function approvalToolNames(): string[] {
  return TOOL_GROUPS.flatMap((g) => g.tools.filter((t: GroupTool) => t.needsApproval).map((t) => t.name));
}
