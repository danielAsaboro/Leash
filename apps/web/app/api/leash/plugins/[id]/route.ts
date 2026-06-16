/**
 * `GET /api/leash/plugins/[id]` — full component inventory (what the plugin WILL register, with the
 * side-effect flags the quarantine review surfaces) · `PUT { enabled }` · `DELETE`.
 */
import { getPlugin, setPluginEnabled, removePlugin, pluginSkills, pluginMcpServers, pluginAgents } from "../../../../../lib/leash/plugins-store.ts";
import { DEFAULT_ASK_FIRST } from "../../../../../lib/leash/tool-config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tools that carry a side-effect / approval gate by default (cross-ref for the review expander). */
function riskyTools(tools: string[]): string[] {
  return tools.filter((t) => DEFAULT_ASK_FIRST.has(t));
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) return Response.json({ error: "not found" }, { status: 404 });

  const prefix = `${id}:`;
  const [allSkills, allMcp, allAgents] = await Promise.all([pluginSkills(), pluginMcpServers(), pluginAgents()]);
  const inventory = {
    skills: allSkills
      .filter((s) => s.slug.startsWith(prefix))
      .map((s) => ({ slug: s.slug, name: s.name, description: s.description, enabled: s.enabled, tools: s.tools, hasScripts: s.files.some((f) => f.startsWith("scripts/")), riskyTools: riskyTools(s.tools) })),
    mcpServers: allMcp
      .filter((m) => m.id.startsWith(`plugin:${id}:`))
      .map((m) => ({ id: m.id, name: m.name, transport: m.transport, enabled: m.enabled, stdio: m.transport === "stdio", ...(m.command ? { command: m.command } : {}), ...(m.url ? { url: m.url } : {}) })),
    agents: allAgents
      .filter((a) => a.slug.startsWith(prefix))
      .map((a) => ({ slug: a.slug, name: a.name, description: a.description, enabled: a.enabled, model: a.model, tools: a.tools, riskyTools: riskyTools(a.tools) })),
  };
  return Response.json({ plugin, inventory });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { enabled: boolean }" }, { status: 400 });
  }
  const enabled = (body as Record<string, unknown>)?.["enabled"];
  if (typeof enabled !== "boolean") return Response.json({ error: "expected JSON body { enabled: boolean }" }, { status: 400 });
  const plugin = await setPluginEnabled(id, enabled);
  if (!plugin) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ plugin });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const removed = await removePlugin(id);
  return Response.json({ ok: removed });
}
