/**
 * `GET /api/leash/tools` — the full tool registry (name + description + enabled +
 * askFirst state). `PUT` — set the disabled list and/or askFirst overrides. The registry
 * is assembled exactly like the chat route's (built-ins + task tools + skill tools +
 * MCP) so the dashboard shows what chat truly has.
 */
import { leashTools } from "../../../../lib/leash/tools.ts";
import { taskTools } from "../../../../lib/leash/task-tools.ts";
import { memoryTools } from "../../../../lib/leash/memory-tools.ts";
import { skillTools } from "../../../../lib/leash/skill-tools.ts";
import { researchTools } from "../../../../lib/leash/research-tools.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { disabledTools, setDisabledTools, askFirstOverrides, setAskFirst, DEFAULT_ASK_FIRST } from "../../../../lib/leash/tool-config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function registry() {
  // chatId only stamps task writes; "dashboard" is a fine placeholder for listing.
  return { ...leashTools, ...taskTools("dashboard"), ...memoryTools("dashboard"), ...skillTools, ...researchTools, ...(await leashMcpTools()) };
}

async function view(): Promise<Response> {
  const [tools, off, ask] = await Promise.all([registry(), disabledTools(), askFirstOverrides()]);
  return Response.json({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: ((t as { description?: string }).description ?? "").slice(0, 240),
      enabled: !off.has(name),
      askFirst: ask[name] ?? DEFAULT_ASK_FIRST.has(name),
      askFirstDefault: DEFAULT_ASK_FIRST.has(name),
    })),
  });
}

export async function GET(): Promise<Response> {
  return view();
}

export async function PUT(req: Request): Promise<Response> {
  const body = (await req.json()) as { disabled?: string[]; askFirst?: Record<string, boolean> };
  if (body.disabled !== undefined && !Array.isArray(body.disabled)) {
    return Response.json({ error: "disabled must be an array of tool names" }, { status: 400 });
  }
  if (body.askFirst !== undefined && (typeof body.askFirst !== "object" || body.askFirst === null || Array.isArray(body.askFirst))) {
    return Response.json({ error: "askFirst must be a map of tool name → boolean" }, { status: 400 });
  }
  if (body.disabled === undefined && body.askFirst === undefined) {
    return Response.json({ error: "nothing to update — send disabled and/or askFirst" }, { status: 400 });
  }
  if (body.disabled) await setDisabledTools(body.disabled);
  if (body.askFirst) await setAskFirst(body.askFirst);
  return view();
}
