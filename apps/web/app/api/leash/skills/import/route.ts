/**
 * `POST /api/leash/skills/import` — import a skill from an uploaded `.zip` (multipart
 * field `file`). agentskills.io layout: one root SKILL.md (+ references/ scripts/
 * assets/ …); a single common top-level folder is stripped. The imported skill always
 * lands DISABLED (review-then-enable posture — see skills-store.ts).
 */
import { unzipSync } from "fflate";
import { importSkill } from "../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 200;

export async function POST(req: Request): Promise<Response> {
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    /* not multipart */
  }
  if (!file) return Response.json({ error: "upload a .zip as the multipart field `file`" }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES) return Response.json({ error: `zip too large (${Math.round(file.size / 1024 / 1024)} MB > 10 MB)` }, { status: 400 });

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    return Response.json({ error: `couldn't read the zip: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
  }

  // Files only (fflate lists folders as trailing-slash zero-length entries); skip
  // metadata droppings (__MACOSX, .DS_Store, any dot-segment).
  let entries = Object.entries(unzipped)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path: path.replace(/\\/g, "/"), data }))
    .filter((e) => !e.path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX"));
  if (entries.length === 0) return Response.json({ error: "the zip is empty" }, { status: 400 });
  if (entries.length > MAX_ENTRIES) return Response.json({ error: `too many files in the zip (${entries.length} > ${MAX_ENTRIES})` }, { status: 400 });

  // Strip a single common root folder ("my-skill/SKILL.md" → "SKILL.md").
  const roots = new Set(entries.map((e) => e.path.split("/")[0]));
  if (roots.size === 1 && entries.every((e) => e.path.includes("/"))) {
    const root = [...roots][0] as string;
    entries = entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) }));
  }

  try {
    const skill = await importSkill(entries);
    return Response.json({ skill }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as Error & { code?: string }).code === "exists" ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
