/** `PATCH /api/leash/memory/items/[id]` (edit) · `DELETE` (forget). */
import { updateMemory, deleteMemory, type MemoryType } from "../../../../../../lib/leash/memories-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const body = (await req.json()) as { type?: MemoryType; text?: string };
  const memory = await updateMemory(id, body);
  if (!memory) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ memory });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const existed = await deleteMemory(id);
  if (!existed) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
