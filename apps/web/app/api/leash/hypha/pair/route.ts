/**
 * `/api/leash/hypha/pair` — proxies the dashboard's pairing actions to the local Hypha
 * daemon's localhost control routes (:11437). The daemon owns the mesh/SDK; the web app
 * only forwards. Daemon-down is surfaced honestly (never a silent empty UI).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${PORT}`;

function daemon(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(6000), cache: "no-store" });
}

export async function GET(): Promise<Response> {
  try {
    const r = await daemon("/pair/state");
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json(
      { mode: false, meshOnline: false, discovered: [], outgoing: null, incoming: null, expiresInMs: null, error: "Hypha daemon not running — start it on the Services page." },
      { status: 200 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { action?: string; on?: boolean; deviceKey?: string; pin?: string; target?: { meshId?: string; newMeshLabel?: string } };
  const map: Record<string, { path: string; payload: object }> = {
    mode: { path: "/pair/mode", payload: { on: body.on, target: body.target } },
    start: { path: "/pair/start", payload: { deviceKey: body.deviceKey } },
    "submit-pin": { path: "/pair/submit-pin", payload: { pin: body.pin } },
    cancel: { path: "/pair/cancel", payload: {} },
  };
  const route = map[body.action ?? ""];
  if (!route) return Response.json({ error: "unknown action" }, { status: 400 });
  try {
    const resp = await daemon(route.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(route.payload) });
    return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Hypha daemon not running — start it on the Services page." }, { status: 503 });
  }
}
