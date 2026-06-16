/** `GET /api/leash/plugins/marketplaces` — list cached marketplace indexes (offline browse)
 *  · `POST { url }` — add / refresh a marketplace index from its URL. */
import { listMarketplaces, addMarketplace } from "../../../../../lib/leash/plugin-sources/marketplace.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ marketplaces: await listMarketplaces() });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { url: string }" }, { status: 400 });
  }
  const url = (body as Record<string, unknown>)?.["url"];
  if (typeof url !== "string") return Response.json({ error: "expected JSON body { url: string }" }, { status: 400 });
  try {
    const marketplace = await addMarketplace(url);
    return Response.json({ marketplace }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
