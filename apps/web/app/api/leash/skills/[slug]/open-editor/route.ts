/**
 * `POST /api/leash/skills/:slug/open-editor` — open the skill's directory in VS Code.
 * Returns `{ opened: true, path }` when the `code` CLI was found and launched, or
 * `{ opened: false, path }` when it was not (ENOENT) so the client can show the path.
 */
import "server-only";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILLS_DIR } from "../../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return Response.json({ error: "invalid skill slug" }, { status: 400 });

  const skillDir = join(SKILLS_DIR, slug);
  try {
    const s = await stat(skillDir);
    if (!s.isDirectory()) return Response.json({ error: `"${slug}" is not a folder-shape skill` }, { status: 404 });
  } catch {
    return Response.json({ error: `skill "${slug}" not found` }, { status: 404 });
  }

  return new Promise((resolve) => {
    const child = spawn("code", [skillDir], { detached: true, stdio: "ignore" });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        // `code` CLI not installed — return path so the client can show it
        resolve(Response.json({ opened: false, path: skillDir }));
      } else {
        resolve(Response.json({ error: `failed to launch VS Code: ${err.message}` }, { status: 500 }));
      }
    });
    child.on("spawn", () => {
      child.unref();
      resolve(Response.json({ opened: true, path: skillDir }));
    });
  });
}
