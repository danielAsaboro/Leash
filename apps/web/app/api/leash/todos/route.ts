/** `GET /api/leash/todos` (filterable list) · `POST` (create) — the Activity dashboard's TODO CRUD.
 *  The MESH is the synced source of truth (via hypha); the local store is the offline fallback.
 *  Reads merge local∪mesh (LWW); writes go to the local store AND write-through to the mesh. */
import { createTask, type TaskStatus, type TaskSource, type TaskPriority } from "../../../../lib/leash/tasks-store.ts";
import { listTasksMerged, syncTaskToMesh } from "../../../../lib/leash/tasks-client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tasks = await listTasksMerged({
    status: (url.searchParams.get("status") as TaskStatus) ?? undefined,
    source: (url.searchParams.get("source") as TaskSource) ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  return Response.json({ todos: tasks });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { title?: string; detail?: string; priority?: TaskPriority; tags?: string[] };
  if (!body.title?.trim()) return Response.json({ error: "title is required" }, { status: 400 });
  const task = await createTask({ title: body.title, detail: body.detail, priority: body.priority, tags: body.tags, source: "user" });
  await syncTaskToMesh(task); // best-effort replicate to the mesh (no-op if hypha is down)
  return Response.json({ todo: task }, { status: 201 });
}
