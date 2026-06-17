/** `GET /api/leash/agents/[slug]` · `PUT` (update a USER subagent) · `DELETE`. Plugin agents
 *  (namespaced `<plugin-id>:<name>`) are read-only here — manage them via their plugin. */
import { getAgent, getUserAgent, saveAgent, deleteAgent } from "../../../../../lib/leash/agents-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A plugin agent slug carries a `:` — those aren't editable through this route. */
function isPluginSlug(slug: string): boolean {
  return slug.includes(":");
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const agent = await getAgent(slug);
  if (!agent) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ agent });
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  if (isPluginSlug(slug)) return Response.json({ error: "plugin agents are read-only — enable/disable the plugin instead" }, { status: 400 });
  const existing = await getUserAgent(slug);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  const body = (await req.json()) as {
    name?: string;
    description?: string;
    body?: string;
    model?: string;
    tools?: string[];
    disallowedTools?: string[];
    skills?: string[];
    maxTurns?: number;
    enabled?: boolean;
  };
  try {
    const agent = await saveAgent({
      slug,
      name: body.name?.trim() || existing.name,
      description: body.description ?? existing.description,
      body: body.body ?? existing.body,
      model: body.model ?? existing.model,
      tools: body.tools ?? existing.tools,
      disallowedTools: body.disallowedTools ?? existing.disallowedTools,
      skills: body.skills ?? existing.skills,
      maxTurns: body.maxTurns ?? existing.maxTurns,
      enabled: body.enabled ?? existing.enabled,
      builtin: existing.builtin,
    });
    return Response.json({ agent });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  if (isPluginSlug(slug)) return Response.json({ error: "plugin agents are read-only — uninstall the plugin instead" }, { status: 400 });
  await deleteAgent(slug);
  return Response.json({ ok: true });
}
