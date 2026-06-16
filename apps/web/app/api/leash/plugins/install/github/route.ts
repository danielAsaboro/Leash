/** `POST /api/leash/plugins/install/github` — install a plugin from a GitHub repo URL.
 *  Body: `{ url: string }`. Lands DISABLED (quarantine). */
import { stageFromGitHub } from "../../../../../../lib/leash/plugin-sources/github.ts";
import { stageAndInstall } from "../../../../../../lib/leash/plugin-sources/install.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { url: string }" }, { status: 400 });
  }
  const url = (body as Record<string, unknown>)?.["url"];
  if (typeof url !== "string") return Response.json({ error: "expected JSON body { url: string }" }, { status: 400 });
  return stageAndInstall({ kind: "github", ref: url }, () => stageFromGitHub(url));
}
