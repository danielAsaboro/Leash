/** `PUT /api/leash/mcp/[id]` (enabled/name) · `DELETE` — stored rows only (env rows are read-only). */
import { updateMcpServer, removeMcpServer } from "../../../../../lib/leash/mcp-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: P): Promise<Response> {
  const { id } = await params;
  const body = (await req.json()) as { enabled?: boolean; name?: string };
  try {
    const server = await updateMcpServer(decodeURIComponent(id), body);
    if (!server) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ server });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: P): Promise<Response> {
  const { id } = await params;
  try {
    const removed = await removeMcpServer(decodeURIComponent(id));
    if (!removed) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
