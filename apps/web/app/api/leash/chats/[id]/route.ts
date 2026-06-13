/** `DELETE` / `PATCH` / `POST /api/leash/chats/[id]` — delete, rename, or truncate (checkpoint revert) a chat. */
import { deleteChat, renameChat, truncateChat } from "../../../../../lib/leash/chat-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { keep: number } — checkpoint revert: keep only the first `keep` messages. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const { keep } = (await req.json()) as { keep?: number };
  if (typeof keep !== "number" || keep < 0) return Response.json({ error: "keep must be a non-negative number" }, { status: 400 });
  const kept = await truncateChat(id, keep);
  return Response.json({ ok: true, kept: kept.length });
}

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
