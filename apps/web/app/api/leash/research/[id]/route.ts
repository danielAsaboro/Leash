/** `GET /api/leash/research/[id]` (status + report) · `POST {action:"cancel"}` · `DELETE` (remove run files). */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { researchStatus, researchReport, RESEARCH_DIR } from "../../../../../lib/leash/research-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Signal-0 liveness probe (same as serve-control.ts). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const status = await researchStatus(id);
  if (!status) return Response.json({ error: "no such run" }, { status: 404 });
  return Response.json({ status, report: await researchReport(id) });
}

/**
 * Cancel an active run: SIGTERM the detached child — it writes its own "cancelled"
 * terminal status (and drains any in-flight serve decode first; wedge rule, see the
 * worker). Pid-reuse risk is bounded: `researchStatus` maps a >3-min-stale run to a
 * terminal error, so we only ever signal a pid that wrote the status file recently.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "cancel") return Response.json({ error: "unsupported action" }, { status: 400 });
  const status = await researchStatus(id);
  if (!status) return Response.json({ error: "no such run" }, { status: 404 });
  if (status.state === "done" || status.state === "error") return Response.json({ ok: true, already: true });
  if (!status.pid || !pidAlive(status.pid)) {
    return Response.json({ error: "the research process is not running anymore — refresh to see its final state" }, { status: 409 });
  }
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    return Response.json({ error: "couldn't signal the research process" }, { status: 500 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!ID_RE.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  for (const f of [`${id}.json`, `${id}.md`]) {
    try {
      await rm(join(RESEARCH_DIR, f));
    } catch {
      /* already gone */
    }
  }
  return Response.json({ ok: true });
}
