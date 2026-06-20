/**
 * `GET /api/leash/tools` — the full tool registry (name + description + enabled +
 * askFirst state). `PUT` — set the disabled list, merge per-tool enabled bits, and/or
 * update askFirst overrides. The registry is assembled exactly like the chat route's
 * (built-ins + task tools + skill tools + MCP) so the dashboard shows what chat truly has.
 */
import { leashTools } from "../../../../lib/leash/tools.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { disabledTools, setDisabledTools, setAskFirst, DEFAULT_ASK_FIRST, toolNeedsApproval } from "../../../../lib/leash/tool-config.ts";
import { policyRequiresApproval } from "@mycelium/leash-core/tool-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function registry() {
  // Capability tools (search_graph, ha_*, tasks, memory, …) come via leashMcpTools() from the
  // toggleable leash-tools-mcp groups; in-process holds just MCP-admin + skills + research.
  return { ...leashTools, ...(await leashMcpTools()) };
}

async function view(): Promise<Response> {
  const [tools, off] = await Promise.all([registry(), disabledTools()]);
  const rows = await Promise.all(
    Object.entries(tools).map(async ([name, t]) => ({
      name,
      description: ((t as { description?: string }).description ?? "").slice(0, 240),
      enabled: !off.has(name),
      askFirst: await toolNeedsApproval(name),
      askFirstDefault: DEFAULT_ASK_FIRST.has(name) || policyRequiresApproval(name),
    })),
  );
  return Response.json({
    tools: rows,
  });
}

export async function GET(): Promise<Response> {
  return view();
}

export async function PUT(req: Request): Promise<Response> {
  const body = (await req.json()) as { disabled?: string[]; enabled?: Record<string, boolean>; askFirst?: Record<string, boolean> };
  if (body.disabled !== undefined && !Array.isArray(body.disabled)) {
    return Response.json({ error: "disabled must be an array of tool names" }, { status: 400 });
  }
  if (body.enabled !== undefined && (typeof body.enabled !== "object" || body.enabled === null || Array.isArray(body.enabled))) {
    return Response.json({ error: "enabled must be a map of tool name → boolean" }, { status: 400 });
  }
  if (body.askFirst !== undefined && (typeof body.askFirst !== "object" || body.askFirst === null || Array.isArray(body.askFirst))) {
    return Response.json({ error: "askFirst must be a map of tool name → boolean" }, { status: 400 });
  }
  if (body.disabled === undefined && body.enabled === undefined && body.askFirst === undefined) {
    return Response.json({ error: "nothing to update — send disabled, enabled, and/or askFirst" }, { status: 400 });
  }
  if (body.disabled !== undefined) await setDisabledTools(body.disabled);
  if (body.enabled !== undefined) {
    const next = await disabledTools();
    for (const [name, enabled] of Object.entries(body.enabled)) {
      if (typeof enabled !== "boolean" || !name.trim()) continue;
      if (enabled) next.delete(name);
      else next.add(name);
    }
    await setDisabledTools([...next]);
  }
  if (body.askFirst !== undefined) await setAskFirst(body.askFirst);
  return view();
}
