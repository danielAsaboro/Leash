/** `POST /api/leash/plugins/install/marketplace` — install a plugin listed in a cached marketplace.
 *  Body: `{ marketplaceId: string, name: string }`. Resolves the entry's source → stage → install
 *  (always DISABLED). */
import { stageFromMarketplace } from "../../../../../../lib/leash/plugin-sources/marketplace.ts";
import { stageAndInstall } from "../../../../../../lib/leash/plugin-sources/install.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { marketplaceId, name }" }, { status: 400 });
  }
  const marketplaceId = (body as Record<string, unknown>)?.["marketplaceId"];
  const name = (body as Record<string, unknown>)?.["name"];
  if (typeof marketplaceId !== "string" || typeof name !== "string") {
    return Response.json({ error: "expected JSON body { marketplaceId, name }" }, { status: 400 });
  }
  // The marketplace source stages AND tells us the resolved source ref (github/mesh) to record.
  let resolved: Awaited<ReturnType<typeof stageFromMarketplace>>;
  try {
    resolved = await stageFromMarketplace(marketplaceId, name);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  return stageAndInstall(resolved.source, async () => resolved.staged);
}
