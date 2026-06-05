/**
 * `GET /api/leash/serve` — supervised serve status (stopped/starting/ready/unhealthy).
 * `POST { action: "start" | "stop" | "restart" }` — process control. stop/restart
 * return 409 while any generation is in flight (GPU-wedge guard); the UI keeps a
 * confirm dialog as the human backstop for the next-dev-restart blind spot (the
 * counter is per-web-process).
 */
import { serveStatus, startServe, stopServe } from "../../../../lib/leash/serve-control.ts";
import { inflightCount } from "../../../../lib/leash/inflight.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(await serveStatus());
}

export async function POST(req: Request): Promise<Response> {
  const { action } = (await req.json()) as { action?: string };
  if (action !== "start" && action !== "stop" && action !== "restart") {
    return Response.json({ error: "action must be start | stop | restart" }, { status: 400 });
  }
  if ((action === "stop" || action === "restart") && inflightCount() > 0) {
    return Response.json({ error: `${inflightCount()} generation(s) in flight — try again when the assistant is idle` }, { status: 409 });
  }

  if (action === "stop") {
    const r = await stopServe();
    return r.ok ? Response.json({ ok: true, status: await serveStatus() }) : Response.json({ error: r.error }, { status: 500 });
  }
  if (action === "restart") {
    const stop = await stopServe();
    if (!stop.ok) return Response.json({ error: stop.error }, { status: 500 });
    const start = await startServe();
    return start.ok ? Response.json({ ok: true, pid: start.pid, status: await serveStatus() }) : Response.json({ error: start.error }, { status: 500 });
  }
  const r = await startServe();
  return r.ok ? Response.json({ ok: true, pid: r.pid, status: await serveStatus() }) : Response.json({ error: r.error }, { status: 409 });
}
