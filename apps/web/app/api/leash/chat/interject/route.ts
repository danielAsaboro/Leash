/** `POST /api/leash/chat/interject` — ask a chat's running turn to yield at its next step boundary. */
import { requestInterject } from "../../../../../lib/leash/interject-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { id } = (await req.json()) as { id?: string };
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  requestInterject(id);
  return Response.json({ ok: true });
}
