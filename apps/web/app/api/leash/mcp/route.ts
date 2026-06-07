/**
 * `GET /api/leash/mcp` — configured MCP servers with live status + tool names.
 * `POST { name?, url, transport? }` — add a server (connects on the next reconcile).
 */
import { addMcpServer } from "../../../../lib/leash/mcp-store.ts";
import { mcpServerStatuses } from "../../../../lib/leash/mcp.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ servers: await mcpServerStatuses() });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { name?: string; url?: string; transport?: "http" | "sse" };
  if (!body.url?.trim()) return Response.json({ error: "url is required" }, { status: 400 });
  try {
    const entry = await addMcpServer({ url: body.url, ...(body.name ? { name: body.name } : {}), ...(body.transport ? { transport: body.transport } : {}) });
    return Response.json({ server: entry }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
