/** `GET /api/leash/skills` (list) · `POST` (create). */
import { listSkills, saveSkill, getSkill, isValidSkillName } from "../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ skills: await listSkills() });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { name?: string; description?: string; enabled?: boolean; body?: string };
  if (!body.name?.trim()) return Response.json({ error: "name is required" }, { status: 400 });
  const slug = body.name.trim();
  if (!isValidSkillName(slug)) return Response.json({ error: "name must be lowercase hyphenated, 1-64 chars, with no spaces, uppercase, or repeated/edge hyphens" }, { status: 400 });
  if (await getSkill(slug)) return Response.json({ error: `a skill "${slug}" already exists` }, { status: 409 });
  const skill = await saveSkill({ name: body.name, description: body.description ?? "", enabled: body.enabled ?? true, body: body.body ?? "" });
  return Response.json({ skill }, { status: 201 });
}
