/** `GET /api/leash/agents` (list — user ∪ plugin) · `POST` (create a user subagent). */
import { listAgents, saveAgent, getUserAgent } from "../../../../lib/leash/agents-store.ts";
import { slugify } from "../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ agents: await listAgents() });
}

export async function POST(req: Request): Promise<Response> {
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
  if (!body.name?.trim()) return Response.json({ error: "name is required" }, { status: 400 });
  const slug = slugify(body.name);
  if (!slug) return Response.json({ error: "name must contain letters or digits" }, { status: 400 });
  if (await getUserAgent(slug)) return Response.json({ error: `an agent "${slug}" already exists` }, { status: 409 });
  try {
    const agent = await saveAgent({
      name: body.name,
      description: body.description ?? "",
      body: body.body ?? "",
      model: body.model ?? "",
      tools: body.tools ?? [],
      disallowedTools: body.disallowedTools ?? [],
      skills: body.skills ?? [],
      ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
      enabled: body.enabled ?? true,
    });
    return Response.json({ agent }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
