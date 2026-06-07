/** `POST /api/leash/elicitations/[id]` — answer a pending MCP elicitation form. */
import { respondElicitation } from "../../../../../lib/leash/elicitations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const body = (await req.json()) as { action?: string; content?: Record<string, unknown> };
  if (body.action !== "accept" && body.action !== "decline" && body.action !== "cancel") {
    return Response.json({ error: "action must be accept | decline | cancel" }, { status: 400 });
  }
  const ok = respondElicitation(id, { action: body.action, ...(body.action === "accept" && body.content ? { content: body.content } : {}) });
  if (!ok) return Response.json({ error: "no such pending elicitation (it may have timed out)" }, { status: 404 });
  return Response.json({ ok: true });
}
