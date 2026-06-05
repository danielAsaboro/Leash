/** `GET /api/leash/skills/[slug]/files/[file]` · `PUT` (create/replace text) · `DELETE`. */
import { readSkillFile, writeSkillFile, deleteSkillFile } from "../../../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ slug: string; file: string }> };

export async function GET(_req: Request, { params }: P): Promise<Response> {
  const { slug, file } = await params;
  const r = await readSkillFile(slug, decodeURIComponent(file));
  if (!r.ok) return Response.json({ error: r.error }, { status: 404 });
  return Response.json({ text: r.text });
}

export async function PUT(req: Request, { params }: P): Promise<Response> {
  const { slug, file } = await params;
  const { content } = (await req.json()) as { content?: string };
  if (typeof content !== "string") return Response.json({ error: "content (string) is required" }, { status: 400 });
  const r = await writeSkillFile(slug, decodeURIComponent(file), content);
  if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: P): Promise<Response> {
  const { slug, file } = await params;
  await deleteSkillFile(slug, decodeURIComponent(file));
  return Response.json({ ok: true });
}
