/** `POST /api/leash/plugins/install/folder` — install a plugin from a local directory.
 *  Body: `{ path: string }` (absolute). Lands DISABLED (quarantine). */
import { stageFromFolder } from "../../../../../../lib/leash/plugin-sources/folder.ts";
import { stageAndInstall } from "../../../../../../lib/leash/plugin-sources/install.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { path: string }" }, { status: 400 });
  }
  const path = (body as Record<string, unknown>)?.["path"];
  if (typeof path !== "string") return Response.json({ error: "expected JSON body { path: string }" }, { status: 400 });
  return stageAndInstall({ kind: "folder", ref: path }, () => stageFromFolder(path));
}
