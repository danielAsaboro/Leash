/** `DELETE` / `PATCH /api/leash/chats/[id]` — delete or rename a stored chat. */
import { deleteChat, renameChat } from "../../../../../lib/leash/chat-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  await deleteChat(id);
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const { title } = (await req.json()) as { title?: string };
  if (typeof title === "string" && title.trim()) await renameChat(id, title);
  return Response.json({ ok: true });
}
