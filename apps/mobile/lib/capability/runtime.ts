import type { ToolSet } from "ai";

import type { CapabilityToolDescriptor } from "../../../../packages/capability-runtime/src/index";
import { buildMobileCapabilitySnapshot, resolveMobileCapabilityTurn, type MobileCapabilitySnapshot } from "./runtime-core";
import {
  listCapabilityAgents,
  listCapabilityMcpServers,
  listCapabilityPlugins,
  listCapabilitySkills,
  readCapabilityToolState,
  syncCapabilitySkillsFromMesh,
} from "./store";
import { loadMobileMcpTools, type MobileMcpStatus } from "./mobile-mcp";
import { MOBILE_TOOL_CATALOG, buildDeviceTools } from "../agent/tools";

export interface MobileCapabilityRuntime {
  snapshot: MobileCapabilitySnapshot;
  mcpStatuses: MobileMcpStatus[];
}

function mcpToolCatalog(tools: ToolSet): CapabilityToolDescriptor[] {
  return Object.entries(tools)
    .map(([name, tool]) => ({
      name,
      description: ((tool as { description?: string }).description ?? "").trim() || "MCP tool",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getMobileCapabilityRuntime(): Promise<MobileCapabilityRuntime> {
  const [skills, agents, plugins, servers, toolState] = await Promise.all([
    listCapabilitySkills(),
    listCapabilityAgents(),
    listCapabilityPlugins(),
    listCapabilityMcpServers(),
    readCapabilityToolState(),
  ]);
  const localTools = buildDeviceTools();
  const pluginServers = plugins.flatMap((plugin) =>
    plugin.mcpServers.map((server) => ({
      ...server,
      enabled: plugin.enabled && server.enabled,
    })),
  );
  const { tools: mcpTools, statuses } = await loadMobileMcpTools([...servers, ...pluginServers]);
  const snapshot = buildMobileCapabilitySnapshot({
    skills,
    agents,
    plugins,
    mcpServers: servers,
    toolCatalog: [...MOBILE_TOOL_CATALOG, ...mcpToolCatalog(mcpTools)],
    toolState,
    localTools,
    mcpTools,
  });
  return { snapshot, mcpStatuses: statuses };
}

export async function resolveMobileCapabilityRuntimeTurn(query: string, baseSystem: string) {
  const runtime = await getMobileCapabilityRuntime();
  const turn = await resolveMobileCapabilityTurn(runtime.snapshot, { query, baseSystem });
  return { runtime, turn };
}

export { syncCapabilitySkillsFromMesh };
