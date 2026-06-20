import { tool, type ToolSet } from "ai";
import { z } from "zod";

interface BrokerSpec {
  name: string;
  label: string;
  tools: string[];
}

export const BROKER_SPECS: BrokerSpec[] = [
  { name: "files_run", label: "Files", tools: ["bash"] },
  { name: "memory_run", label: "Memory", tools: ["remember", "recall"] },
  { name: "tasks_run", label: "TODOs", tools: ["create_task", "list_tasks", "update_task"] },
  { name: "context_run", label: "Context", tools: ["search_graph", "active_context", "activity_recent", "understory_search", "understory_today"] },
  { name: "mcp_run", label: "MCP admin", tools: ["install_mcp_repo", "upsert_mcp_server"] },
];

export const BROKER_TOOL_NAMES: ReadonlySet<string> = new Set(BROKER_SPECS.map((s) => s.name));
export const BROKERED_RAW_TOOL_NAMES: ReadonlySet<string> = new Set(BROKER_SPECS.flatMap((s) => s.tools));

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (Array.isArray(rec.content)) {
    const text = rec.content
      .map((part) => (part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "text" ? (part as Record<string, unknown>)["text"] : ""))
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(value);
}

function normalizeBrokerResult(action: string, result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { action, text: String(result ?? "") };
  const rec = result as Record<string, unknown>;
  return { ...rec, action, text: outputText(result) };
}

export function buildCapabilityBrokers(registry: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const spec of BROKER_SPECS) {
    const live = spec.tools.filter((name) => typeof (registry[name] as { execute?: unknown } | undefined)?.execute === "function");
    if (live.length === 0) continue;
    const actionSchema = live.length === 1 ? z.literal(live[0] as string) : z.enum(live as [string, ...string[]]);
    out[spec.name] = tool({
      description: `${spec.label} broker. Choose one action and pass that action's JSON input. Available actions: ${live.join(", ")}.`,
      inputSchema: z.object({
        action: actionSchema.describe("The capability action to run."),
        input: z.record(z.string(), z.unknown()).default({}).describe("JSON input for the selected action."),
      }),
      execute: async ({ action, input }, opts) => {
        const target = registry[action] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> } | undefined;
        if (typeof target?.execute !== "function") return { action, text: `Action "${action}" is not available.` };
        return normalizeBrokerResult(action, await target.execute(input, opts));
      },
    });
  }
  return out;
}
