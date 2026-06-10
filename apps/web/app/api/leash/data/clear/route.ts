/**
 * `POST /api/leash/data/clear` — `{ category }` → empty one user-content category from disk.
 * Restricted to the `CLEARABLE` allow-list in lib/leash/storage.ts (never device identity, the
 * mesh stores, the economy ledger, or secrets). Irreversible; the UI confirms first.
 */
import { clearCategory } from "../../../../../lib/leash/storage.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { category } = (await req.json()) as { category?: string };
  if (!category) return Response.json({ error: "category is required" }, { status: 400 });
  const ok = await clearCategory(category);
  return ok ? Response.json({ ok: true, cleared: category }) : Response.json({ error: "unknown or non-clearable category" }, { status: 400 });
}
