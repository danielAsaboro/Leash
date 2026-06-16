/** `GET /api/leash/plugins` — list installed plugins (registry rows). */
import { listPlugins } from "../../../../lib/leash/plugins-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ plugins: await listPlugins() });
}
