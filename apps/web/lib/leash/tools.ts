/**
 * Leash's in-process AI SDK tool registry (server-only).
 *
 * The capability tools that used to live here — search_graph, understory_*, list_photos,
 * generate_image, ha_*, active_context, activity_recent — have moved into the
 * `leash-tools-mcp` daemon as toggleable MCP server GROUPS (Home Assistant, Feed, Memory,
 * Tasks, Context, Photos, Image). They reach chat via `leashMcpTools()` when their group is
 * enabled in Brain → MCP, so toggling a server off takes the whole group offline.
 *
 * What stays in-process here is `mcpAdminTools` (skill-gated MCP management) — it manages the
 * MCP layer itself and so can't live behind it. The other in-process tools (skills,
 * sandboxed bash, plan) are assembled in the chat route, not here.
 *
 * `LeashSource` (the citation shape every tool returns) now lives in `@mycelium/leash-core`
 * and is re-exported here so existing `import { LeashSource } from "./tools.ts"` sites keep
 * resolving.
 */
import "server-only";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export type { LeashSource } from "@mycelium/leash-core/sources";

/**
 * The in-process tool registry is now EMPTY — capabilities are reached via `leashMcpTools()`
 * or assembled as agent control-flow tools in the chat route.
 * Kept as an (empty) export so the registry-assembly sites still spread it without a special case.
 * `run_skill` / `submit_plan` are agent control-flow built in the chat route, not listed tools.
 */
const round = (n: number): number => Number(n.toPrecision(12));

/** Public-safe tools are pure, deterministic, and receive no ambient device state. */
export const leashTools: ToolSet = {
  public_calculate: tool({
    description: "Perform one arithmetic operation on two finite numbers. Public-safe: no device or user data is read.",
    inputSchema: z.object({ left: z.number().finite(), operator: z.enum(["add", "subtract", "multiply", "divide", "power"]), right: z.number().finite() }),
    execute: async ({ left, operator, right }) => {
      if (operator === "divide" && right === 0) throw new Error("division by zero");
      const value = operator === "add" ? left + right : operator === "subtract" ? left - right : operator === "multiply" ? left * right : operator === "divide" ? left / right : left ** right;
      if (!Number.isFinite(value)) throw new Error("non-finite result");
      return { value: round(value), expression: `${left} ${operator} ${right}` };
    },
  }),
  public_convert_units: tool({
    description: "Convert a numeric distance between metres, kilometres, miles, and feet. Public-safe: no device or user data is read.",
    inputSchema: z.object({ value: z.number().finite(), from: z.enum(["m", "km", "mi", "ft"]), to: z.enum(["m", "km", "mi", "ft"]) }),
    execute: async ({ value, from, to }) => {
      const metres = value * ({ m: 1, km: 1000, mi: 1609.344, ft: 0.3048 } as const)[from];
      const converted = metres / ({ m: 1, km: 1000, mi: 1609.344, ft: 0.3048 } as const)[to];
      return { value: round(converted), unit: to, source: { value, unit: from } };
    },
  }),
};
