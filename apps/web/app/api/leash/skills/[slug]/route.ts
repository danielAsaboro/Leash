/** `GET /api/leash/skills/[slug]` · `PUT` (update) · `DELETE`. */
import { getSkill, saveSkill, deleteSkill } from "../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const skill = await getSkill(slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ skill });
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const existing = await getSkill(slug);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  const body = (await req.json()) as { name?: string; description?: string; enabled?: boolean; body?: string };
  const skill = await saveSkill({
    slug,
    name: body.name?.trim() || existing.name,
    description: body.description ?? existing.description,
    enabled: body.enabled ?? existing.enabled,
    body: body.body ?? existing.body,
  });
  return Response.json({ skill });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  await deleteSkill(slug);
  return Response.json({ ok: true });
}
