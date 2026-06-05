/**
 * `DELETE /api/leash/models/loaded/[alias]` — LIVE-UNLOAD a model from the running
 * serve (proxy of the serve's `DELETE /v1/models/:id`; verified instant). Honest UI
 * note: there is no HTTP load — reloading needs a config entry + serve restart.
 */
import { QVAC_OPENAI_URL } from "../../../../../../lib/leash/models.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ alias: string }> }): Promise<Response> {
  const { alias } = await params;
  let upstream: Response;
  try {
    upstream = await fetch(`${QVAC_OPENAI_URL}/models/${encodeURIComponent(alias)}`, { method: "DELETE" });
  } catch {
    return Response.json({ error: "The serve is offline — nothing to unload." }, { status: 503 });
  }
  const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  if (!upstream.ok) {
    const message = (body["error"] as { message?: string } | undefined)?.message ?? `Unload failed (HTTP ${upstream.status}).`;
    return Response.json({ error: message }, { status: upstream.status });
  }
  return Response.json(body);
}
