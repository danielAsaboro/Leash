/**
 * `POST /api/leash/memory/forget` — REAL forgetting:
 *   { kind: "note", file }    → delete the note file (graph re-embeds via dir fingerprint)
 *   { kind: "activity", ts }  → tombstone the record (JSONL never rewritten)
 */
import { deleteNote, forgetActivity } from "../../../../../lib/leash/memory-admin.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { kind?: string; file?: string; ts?: string };
  if (body.kind === "note" && body.file) {
    const ok = await deleteNote(body.file);
    return ok ? Response.json({ ok: true }) : Response.json({ error: "note not found" }, { status: 404 });
  }
  if (body.kind === "activity" && body.ts) {
    await forgetActivity(body.ts);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "expected { kind: 'note', file } or { kind: 'activity', ts }" }, { status: 400 });
}
