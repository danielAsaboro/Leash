/**
 * `/api/leash/hypha/mesh` — proxies mesh-membership actions (disconnect/restore a peer, clear
 * stale peers, and multi-mesh management: found a new mesh, mint an invite for one, join another)
 * to the local Hypha daemon (:11437). Daemon-down is surfaced, never silent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${PORT}`;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { action?: string; deviceKey?: string; meshId?: string; label?: string; invite?: string; cellId?: string };
  const map: Record<string, { path: string; payload: object }> = {
    forget: { path: "/mesh/forget", payload: { deviceKey: body.deviceKey } },
    "forget-stale": { path: "/mesh/forget-stale", payload: {} },
    restore: { path: "/mesh/restore", payload: { deviceKey: body.deviceKey } },
    new: { path: "/mesh/new", payload: { label: body.label } },
    invite: { path: "/mesh/invite", payload: { meshId: body.meshId } },
    join: { path: "/mesh/join", payload: { invite: body.invite, label: body.label } },
    "public-join": { path: "/mesh/public/join", payload: { cellId: body.cellId, label: body.label } },
    delete: { path: "/mesh/delete", payload: { meshId: body.meshId } },
  };
  const route = map[body.action ?? ""];
  if (!route) return Response.json({ error: "unknown action" }, { status: 400 });
  try {
    const resp = await fetch(`${BASE}${route.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(route.payload), signal: AbortSignal.timeout(8000), cache: "no-store" });
    return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Hypha daemon not running — start it on the Services page." }, { status: 503 });
  }
}
