/**
 * `POST /api/leash/skills/import-folder` — import a skill from a local directory.
 * Body: `{ path: string }` (JSON). The path must be absolute, exist, be a directory,
 * and contain a root SKILL.md. All files are read and passed to importSkill().
 * The imported skill lands DISABLED (review-then-enable posture).
 */
import "server-only";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { importSkill } from "../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 200;
const MAX_DEPTH = 3;

/** Recursively walk a directory, returning relative POSIX paths + Uint8Array data. */
async function walkDir(root: string): Promise<Array<{ path: string; data: Uint8Array }>> {
  const out: Array<{ path: string; data: Uint8Array }> = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".")) continue; // skip dotfiles
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(relPath, depth + 1);
      } else if (e.isFile()) {
        try {
          const buf = await readFile(join(root, relPath));
          out.push({ path: relPath, data: new Uint8Array(buf) });
        } catch {
          /* skip unreadable files */
        }
      }
    }
  };
  await walk("", 1);
  return out;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { path: string }" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>)["path"] !== "string") {
    return Response.json({ error: "expected JSON body { path: string }" }, { status: 400 });
  }
  const folderPath = ((body as Record<string, unknown>)["path"] as string).trim();
  if (!folderPath || !isAbsolute(folderPath)) {
    return Response.json({ error: "path must be an absolute directory path" }, { status: 400 });
  }

  let dirStat;
  try {
    dirStat = await stat(folderPath);
  } catch {
    return Response.json({ error: `path not found: "${folderPath}"` }, { status: 400 });
  }
  if (!dirStat.isDirectory()) {
    return Response.json({ error: `"${folderPath}" is not a directory` }, { status: 400 });
  }

  // Verify SKILL.md exists at the root before walking.
  try {
    await stat(join(folderPath, "SKILL.md"));
  } catch {
    return Response.json({ error: `no SKILL.md found at the root of "${folderPath}"` }, { status: 400 });
  }

  const entries = await walkDir(folderPath);
  if (entries.length === 0) return Response.json({ error: "the directory is empty" }, { status: 400 });
  if (entries.length > MAX_FILES) return Response.json({ error: `too many files in the directory (${entries.length} > ${MAX_FILES})` }, { status: 400 });

  try {
    const skill = await importSkill(entries);
    return Response.json({ skill }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as Error & { code?: string }).code === "exists" ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
