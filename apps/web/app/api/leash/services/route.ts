/**
 * `GET /api/leash/services` — every service's status (serve included).
 * `POST { name, action: "start" | "stop" | "restart" }` — daemon control. The serve's
 * stop/restart keeps its inflight 409 guard (delegated to serve-control via services).
 */
import { servicesStatus, startService, stopService, type ServiceName } from "../../../../lib/leash/services.ts";
import { inflightCount } from "../../../../lib/leash/inflight.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAMES: ServiceName[] = ["qvac-serve", "watcher", "newsroom", "leash-cron"];

export async function GET(): Promise<Response> {
  return Response.json({ services: await servicesStatus() });
}

export async function POST(req: Request): Promise<Response> {
  const { name, action } = (await req.json()) as { name?: ServiceName; action?: string };
  if (!name || !NAMES.includes(name)) return Response.json({ error: "unknown service" }, { status: 400 });
  if (action !== "start" && action !== "stop" && action !== "restart") {
    return Response.json({ error: "action must be start | stop | restart" }, { status: 400 });
  }
  if (name === "qvac-serve" && (action === "stop" || action === "restart") && inflightCount() > 0) {
    return Response.json({ error: `${inflightCount()} generation(s) in flight — try again when the assistant is idle` }, { status: 409 });
  }

  if (action === "stop" || action === "restart") {
    const r = await stopService(name);
    if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
    if (action === "stop") return Response.json({ ok: true });
  }
  const r = await startService(name);
  return r.ok ? Response.json({ ok: true, pid: r.pid }) : Response.json({ error: r.error }, { status: 409 });
}
