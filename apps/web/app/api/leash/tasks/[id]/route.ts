/** `PATCH /api/leash/tasks/[id]` (update) · `DELETE` (remove). */
import { updateTask, deleteTask, type TaskPatch } from "../../../../../lib/leash/tasks-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const patch = (await req.json()) as TaskPatch;
  const task = await updateTask(id, patch);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ task });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const existed = await deleteTask(id);
  if (!existed) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
