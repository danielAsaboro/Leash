/** `GET /api/leash/research/[id]` (status + report) · `DELETE` (remove run files). */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { researchStatus, researchReport, RESEARCH_DIR } from "../../../../../lib/leash/research-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const status = await researchStatus(id);
  if (!status) return Response.json({ error: "no such run" }, { status: 404 });
  return Response.json({ status, report: await researchReport(id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!ID_RE.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  for (const f of [`${id}.json`, `${id}.md`]) {
    try {
      await rm(join(RESEARCH_DIR, f));
    } catch {
      /* already gone */
    }
  }
  return Response.json({ ok: true });
}
