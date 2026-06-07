/** `GET /api/leash/elicitations` — currently-pending MCP elicitation forms (reload recovery). */
import { listPendingElicitations } from "../../../../lib/leash/elicitations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ elicitations: listPendingElicitations() });
}
