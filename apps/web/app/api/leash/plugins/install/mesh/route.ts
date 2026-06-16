/** `POST /api/leash/plugins/install/mesh` — install a plugin replicated over the device mesh.
 *  Body: `{ pluginId: string }`. The hypha daemon fetches + verifies; lands DISABLED (quarantine). */
import { stageFromMesh } from "../../../../../../lib/leash/plugin-sources/mesh.ts";
import { stageAndInstall } from "../../../../../../lib/leash/plugin-sources/install.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { pluginId: string }" }, { status: 400 });
  }
  const pluginId = (body as Record<string, unknown>)?.["pluginId"];
  if (typeof pluginId !== "string") return Response.json({ error: "expected JSON body { pluginId: string }" }, { status: 400 });
  return stageAndInstall({ kind: "mesh", ref: pluginId }, () => stageFromMesh(pluginId));
}
