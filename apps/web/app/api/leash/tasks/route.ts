/** `GET /api/leash/tasks` (filterable list) · `POST` (create) — the dashboard's task CRUD. */
import { listTasks, createTask, type TaskStatus, type TaskSource, type TaskPriority } from "../../../../lib/leash/tasks-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tasks = await listTasks({
    status: (url.searchParams.get("status") as TaskStatus) ?? undefined,
    source: (url.searchParams.get("source") as TaskSource) ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  return Response.json({ tasks });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { title?: string; detail?: string; priority?: TaskPriority; tags?: string[] };
  if (!body.title?.trim()) return Response.json({ error: "title is required" }, { status: 400 });
  const task = await createTask({ title: body.title, detail: body.detail, priority: body.priority, tags: body.tags, source: "user" });
  return Response.json({ task }, { status: 201 });
}
