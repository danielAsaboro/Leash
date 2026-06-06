/**
 * `/api/leash/hypha/mesh` — proxies mesh-membership actions (disconnect a peer, clear stale
 * peers) to the local Hypha daemon (:11437). Daemon-down is surfaced, never silent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${PORT}`;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { action?: string; deviceKey?: string };
  const map: Record<string, { path: string; payload: object }> = {
    forget: { path: "/mesh/forget", payload: { deviceKey: body.deviceKey } },
    "forget-stale": { path: "/mesh/forget-stale", payload: {} },
    restore: { path: "/mesh/restore", payload: { deviceKey: body.deviceKey } },
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
