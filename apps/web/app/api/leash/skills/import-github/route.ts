/**
 * `POST /api/leash/skills/import-github` — import a skill from a GitHub repo URL.
 * Body: `{ url: string }` (JSON). Accepts:
 *   https://github.com/{owner}/{repo}
 *   https://github.com/{owner}/{repo}/tree/{ref}
 *   https://github.com/{owner}/{repo}/tree/{ref}/{subfolder/path}
 * Fetches the zipball for the given ref (defaults to HEAD), strips the single root
 * folder GitHub always adds, filters to the subfolder if given, then delegates to
 * importSkill(). The imported skill lands DISABLED (review-then-enable posture).
 */
import { unzipSync } from "fflate";
import { importSkill } from "../../../../../lib/leash/skills-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 200;

/** Parse a GitHub repo URL. Returns null for non-GitHub or unrecognised shapes. */
function parseGitHubUrl(raw: string): { owner: string; repo: string; ref: string; subfolder: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
  // Path segments: ["", owner, repo, "tree"?, ref?, ...subfolder]
  const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0] as string;
  const repo = (parts[1] as string).replace(/\.git$/, "");
  if (!owner || !repo) return null;
  let ref = "HEAD";
  let subfolder = "";
  if (parts[2] === "tree" && parts.length >= 4) {
    ref = parts[3] as string;
    subfolder = parts.slice(4).join("/");
  }
  return { owner, repo, ref, subfolder };
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body { url: string }" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>)["url"] !== "string") {
    return Response.json({ error: "expected JSON body { url: string }" }, { status: 400 });
  }
  const raw = ((body as Record<string, unknown>)["url"] as string).trim();
  const parsed = parseGitHubUrl(raw);
  if (!parsed) return Response.json({ error: "url must be a GitHub repo URL (https://github.com/owner/repo[/tree/ref[/subfolder]])" }, { status: 400 });

  const { owner, repo, ref, subfolder } = parsed;
  const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${ref}`;

  let zipBytes: ArrayBuffer;
  try {
    const res = await fetch(zipUrl, {
      headers: { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "follow",
    });
    if (!res.ok) {
      const msg = res.status === 404 ? `repo "${owner}/${repo}" not found (or private)` : `GitHub returned ${res.status}`;
      return Response.json({ error: msg }, { status: 400 });
    }
    zipBytes = await res.arrayBuffer();
  } catch (err) {
    return Response.json({ error: `couldn't fetch from GitHub: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
  }

  if (zipBytes.byteLength > MAX_ZIP_BYTES) {
    return Response.json({ error: `zip too large (${Math.round(zipBytes.byteLength / 1024 / 1024)} MB > 10 MB)` }, { status: 400 });
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(zipBytes));
  } catch (err) {
    return Response.json({ error: `couldn't read the zip: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
  }

  // Files only; skip metadata droppings.
  let entries = Object.entries(unzipped)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path: path.replace(/\\/g, "/"), data }))
    .filter((e) => !e.path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX"));

  if (entries.length === 0) return Response.json({ error: "the zip is empty" }, { status: 400 });

  // GitHub always adds a single root folder (owner-repo-sha/…) — strip it unconditionally.
  const roots = new Set(entries.map((e) => e.path.split("/")[0]));
  if (roots.size === 1 && entries.every((e) => e.path.includes("/"))) {
    const root = [...roots][0] as string;
    entries = entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) }));
  }

  // If a subfolder was specified in the URL, filter and strip it.
  if (subfolder) {
    const prefix = subfolder.replace(/^\/|\/$/g, "") + "/";
    const sub = entries.filter((e) => e.path.startsWith(prefix)).map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
    if (sub.length === 0) return Response.json({ error: `subfolder "${subfolder}" not found in the repo` }, { status: 400 });
    entries = sub;
  }

  if (entries.length > MAX_ENTRIES) return Response.json({ error: `too many files in the zip (${entries.length} > ${MAX_ENTRIES})` }, { status: 400 });

  try {
    const skill = await importSkill(entries);
    return Response.json({ skill }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as Error & { code?: string }).code === "exists" ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
