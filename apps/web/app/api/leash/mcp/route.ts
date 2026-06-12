/**
 * `GET /api/leash/mcp` — configured MCP servers with live status + tool names.
 * `POST { name?, transport?, url?, headers?, command?, args?, cwd?, env? }` — add a server
 *   (http/sse via url[+headers] or stdio via command[+args/cwd/env]); connects on the next
 *   reconcile. Validation + per-transport rules live in `mcp-config.ts`.
 */
import { addMcpServer } from "../../../../lib/leash/mcp-store.ts";
import type { McpServerInput } from "../../../../lib/leash/mcp-config.ts";
import { mcpServerStatuses, retryMcpServer } from "../../../../lib/leash/mcp.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ servers: await mcpServerStatuses() });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as McpServerInput;
  try {
    const entry = await addMcpServer(body);
    await retryMcpServer(entry.id);
    return Response.json({ server: entry }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
