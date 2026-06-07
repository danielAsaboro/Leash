/**
 * `POST /api/leash/newsroom/articles/[id]` `{action:"requeue"}` — send a stuck article
 * back to QUEUED so the daemon picks it up on its next tick. This is a FULL pipeline
 * re-run (research → draft → review); there is no per-stage resume.
 *
 * ⚠ SECOND SQLITE WRITER — deliberate exception. The newsroom daemon is normally the
 * db's only writer (see packages/db/prisma/schema.prisma header). This single-row,
 * user-initiated stage flip is the one sanctioned crack in that rule (user signed off):
 * WAL mode makes a lone UPDATE safe alongside the daemon. Don't add bulk writes here.
 *
 * Double-processing guard, re-checked SERVER-SIDE (never trust the button state):
 * only mid-pipeline stages, and only when untouched for >5 min (a row the daemon is
 * actively working keeps its updatedAt fresh on stage transitions).
 */
import { prisma, Stage } from "@mycelium/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STUCK_STAGES: string[] = [Stage.RESEARCHING, Stage.RESEARCH_READY, Stage.DRAFTING, Stage.REVIEW];
const STALL_MS = 5 * 60_000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "requeue") return Response.json({ error: "unsupported action" }, { status: 400 });

  const article = await prisma.article.findUnique({ where: { id }, select: { id: true, stage: true, updatedAt: true, headline: true } });
  if (!article) return Response.json({ error: "no such article" }, { status: 404 });
  if (!STUCK_STAGES.includes(article.stage)) {
    return Response.json({ error: `only mid-pipeline articles can be re-queued (this one is ${article.stage})` }, { status: 409 });
  }
  const idleMs = Date.now() - new Date(article.updatedAt).getTime();
  if (idleMs < STALL_MS) {
    return Response.json({ error: `still active — touched ${Math.round(idleMs / 1000)}s ago; wait for it to stall (>5 min) before re-queuing` }, { status: 409 });
  }

  await prisma.article.update({ where: { id }, data: { stage: Stage.QUEUED, startedAt: null } });
  return Response.json({ ok: true });
}
