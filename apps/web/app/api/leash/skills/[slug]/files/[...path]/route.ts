/**
 * `GET /api/leash/skills/[slug]/files/[...path]` · `PUT` (create/replace text) · `DELETE`.
 * Catch-all so nested spec paths (`references/x.md`, `scripts/y.sh`) are addressable;
 * the store's `safeRelPath` + realpath containment validate every segment.
 */
import { readSkillFile, writeSkillFile, deleteSkillFile } from "../../../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ slug: string; path: string[] }> };

/** Next delivers decoded segments; re-join them into the store's relative POSIX path. */
const relOf = (path: string[]): string => path.join("/");

export async function GET(_req: Request, { params }: P): Promise<Response> {
  const { slug, path } = await params;
  const r = await readSkillFile(slug, relOf(path));
  if (!r.ok) return Response.json({ error: r.error }, { status: 404 });
  return Response.json({ text: r.text });
}

export async function PUT(req: Request, { params }: P): Promise<Response> {
  const { slug, path } = await params;
  const { content } = (await req.json()) as { content?: string };
  if (typeof content !== "string") return Response.json({ error: "content (string) is required" }, { status: 400 });
  const r = await writeSkillFile(slug, relOf(path), content);
  if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: P): Promise<Response> {
  const { slug, path } = await params;
  await deleteSkillFile(slug, relOf(path));
  return Response.json({ ok: true });
}
