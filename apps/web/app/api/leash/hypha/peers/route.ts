/**
 * `GET /api/leash/hypha/peers` — the node-state feed for the living-mesh visualization.
 * Proxies the local Hypha daemon's `/peers` (:11437) — the full PeerView rows (compute class,
 * RAM, power state, inflight, served/warm models, settlement) plus `self` (this device's own
 * provider key + payout wallet) and the mesh memberships. The `/events` SSE supplies the live
 * activity; this supplies the topology + per-node status the graph lays out.
 *
 * Daemon-down is surfaced honestly (`ok:false`, 503) — never a fabricated empty mesh.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${PORT}`;

export async function GET(): Promise<Response> {
  try {
    const r = await fetch(`${BASE}/peers`, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ ok: false, error: "Hypha daemon not running — start it on the Services page." }, { status: 503 });
  }
}
