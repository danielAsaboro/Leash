/**
 * `PUT /api/leash/mcp/[id]` (enabled/name) · `DELETE`.
 *
 * Built-ins (mesh tools): toggling `enabled` drives the daemon lifecycle (start+await
 * health / stop) via `toggleBuiltin`; they can't be renamed or removed. Env rows are
 * read-only. Stored rows: plain enabled/name update + delete.
 */
import { updateMcpServer, removeMcpServer, type McpServerPatch } from "../../../../../lib/leash/mcp-store.ts";
import { builtinById } from "../../../../../lib/leash/mcp-builtins.ts";
import { toggleBuiltin } from "../../../../../lib/leash/mcp-lifecycle.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: P): Promise<Response> {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const body = (await req.json().catch(() => ({}))) as McpServerPatch;
  try {
    if (builtinById(id) && typeof body.enabled === "boolean") {
      const { server, warning } = await toggleBuiltin(id, body.enabled);
      return Response.json({ server, ...(warning ? { warning } : {}) });
    }
    const server = await updateMcpServer(id, body);
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
