/** `PATCH /api/leash/tasks/[id]` (update) · `DELETE` (remove). Writes go to the local store AND
 *  write-through to the mesh (best-effort) so edits/deletes replicate to the user's other devices. */
import { updateTask, deleteTask, type TaskPatch } from "../../../../../lib/leash/tasks-store.ts";
import { syncTaskToMesh, deleteTaskFromMesh } from "../../../../../lib/leash/tasks-client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const patch = (await req.json()) as TaskPatch;
  const task = await updateTask(id, patch);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  await syncTaskToMesh(task); // best-effort replicate the edit to the mesh
  return Response.json({ task });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const existed = await deleteTask(id);
  if (!existed) return Response.json({ error: "not found" }, { status: 404 });
  await deleteTaskFromMesh(id); // best-effort tombstone in the mesh
  return Response.json({ ok: true });
}
