/**
 * `GET /api/leash/hypha/events` — relays the Hypha daemon's live routing-event SSE stream
 * (:11437 `/events`) to the browser so the living-mesh visualization can subscribe with a
 * plain `EventSource`. The daemon owns the mesh/SDK; this route only pipes its stream.
 *
 * Daemon-down is surfaced as a single honest `down` SSE frame (the down-daemon pattern of
 * the sibling hypha routes) — never a hang, never a fabricated routing event. Client
 * disconnect propagates to the upstream fetch via `req.signal`, so the daemon's `/events`
 * subscription is released when the tab closes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${PORT}`;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
} as const;

function down(message: string): Response {
  return new Response(`event: down\ndata: ${JSON.stringify({ error: message })}\n\n`, { status: 200, headers: SSE_HEADERS });
}

export async function GET(req: Request): Promise<Response> {
  let upstream: Response;
  try {
    // No body timeout — this is a long-lived stream; only a CONNECT failure should bail.
    upstream = await fetch(`${BASE}/events`, { headers: { accept: "text/event-stream" }, signal: req.signal, cache: "no-store" });
  } catch {
    return down("Hypha daemon not running — start it on the Services page.");
  }
  if (!upstream.ok || !upstream.body) return down(`Hypha events unavailable (status ${upstream.status}).`);
  return new Response(upstream.body, { status: 200, headers: SSE_HEADERS });
}
