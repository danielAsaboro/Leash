/**
 * `PUT /api/leash/models/config` — edit `serve.models` in qvac.config.base.json:
 *   { action: "add", alias, model }   → add/replace an alias (SDK constant, preload)
 *   { action: "remove", alias }       → drop an alias
 * Honest semantics: changes apply on the NEXT serve restart (no HTTP load exists).
 */
import { addModelToConfig, removeModelFromConfig } from "../../../../../lib/leash/models.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request): Promise<Response> {
  const body = (await req.json()) as { action?: string; alias?: string; model?: string };
  if (!body.alias) return Response.json({ error: "alias is required" }, { status: 400 });
  if (body.action === "add") {
    if (!body.model) return Response.json({ error: "model (SDK constant name) is required" }, { status: 400 });
    const r = await addModelToConfig(body.alias, body.model);
    return r.ok ? Response.json({ ok: true, appliesOn: "next serve restart" }) : Response.json({ error: r.error }, { status: 400 });
  }
  if (body.action === "remove") {
    const r = await removeModelFromConfig(body.alias);
    return r.ok ? Response.json({ ok: true, appliesOn: "next serve restart" }) : Response.json({ error: r.error }, { status: 404 });
  }
  return Response.json({ error: "action must be add | remove" }, { status: 400 });
}
