/** `GET /api/leash/memory` — notes + a page of activity + RAG index stats. */
import { listNotes, activityPage, indexStats } from "../../../../lib/leash/memory-admin.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const [notes, activity, stats] = await Promise.all([listNotes(), activityPage(offset, limit), indexStats()]);
  return Response.json({ notes, activity, stats });
}
