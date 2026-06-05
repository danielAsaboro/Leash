/** `PATCH /api/leash/schedules/[id]` (edit/toggle) · `DELETE`. */
import { updateSchedule, deleteSchedule, type ScheduleEntry } from "../../../../../lib/leash/schedules-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const patch = (await req.json()) as Partial<Omit<ScheduleEntry, "id" | "createdAt">>;
  const entry = await updateSchedule(id, patch);
  if (!entry) return Response.json({ error: "not found or invalid patch" }, { status: 400 });
  return Response.json({ schedule: entry });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const existed = await deleteSchedule(id);
  if (!existed) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
