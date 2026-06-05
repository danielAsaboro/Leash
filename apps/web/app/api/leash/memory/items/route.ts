/** `GET /api/leash/memory/items` (filterable) · `POST` (create) — typed memories. */
import { listMemories, addMemory, MEMORY_TYPES, type MemoryType } from "../../../../../lib/leash/memories-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") as MemoryType | null;
  const memories = await listMemories({
    type: type && MEMORY_TYPES.includes(type) ? type : undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  return Response.json({ memories });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { type?: MemoryType; text?: string };
  if (!body.type || !MEMORY_TYPES.includes(body.type)) return Response.json({ error: "type must be one of " + MEMORY_TYPES.join("|") }, { status: 400 });
  if (!body.text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
  const memory = await addMemory({ type: body.type, text: body.text, source: "user" });
  return Response.json({ memory }, { status: 201 });
}
