/**
 * GitHub plugin source (server-only) — stage a plugin from a GitHub repo URL.
 *
 * Lifted from `skills/import-github/route.ts` (zipball fetch → unzip → strip the single root folder
 * GitHub adds → optional subfolder filter), generalized to a reusable `stageFromGitHub(url)` that
 * stages the WHOLE plugin tree (not a single SKILL.md). The zip-size cap is bumped vs the skills
 * importer — a plugin bundles skills + agents + MCP config, so it's legitimately larger.
 */
import "server-only";
import { unzipSync } from "fflate";
import { stageEntries, type StagedPlugin, type StagedEntry } from "./stage.ts";

const MAX_ZIP_BYTES = 25 * 1024 * 1024;

/** Parse a GitHub repo URL → owner/repo/ref/subfolder. Null for non-GitHub or unrecognised shapes. */
export function parseGitHubUrl(raw: string): { owner: string; repo: string; ref: string; subfolder: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
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

/** Fetch + extract a GitHub repo (or subfolder) into a staged plugin tree. */
export async function stageFromGitHub(rawUrl: string): Promise<StagedPlugin> {
  const parsed = parseGitHubUrl(rawUrl);
  if (!parsed) throw new Error("url must be a GitHub repo URL (https://github.com/owner/repo[/tree/ref[/subfolder]])");
  const { owner, repo, ref, subfolder } = parsed;
  const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${ref}`;

  let zipBytes: ArrayBuffer;
  const res = await fetch(zipUrl, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(res.status === 404 ? `repo "${owner}/${repo}" not found (or private)` : `GitHub returned ${res.status}`);
  zipBytes = await res.arrayBuffer();
  if (zipBytes.byteLength > MAX_ZIP_BYTES) throw new Error(`zip too large (${Math.round(zipBytes.byteLength / 1024 / 1024)} MB > ${MAX_ZIP_BYTES / 1024 / 1024} MB)`);

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(zipBytes));
  } catch (err) {
    throw new Error(`couldn't read the zip: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Files only; skip the `.git`/`__MACOSX` droppings (but KEEP the plugin's own dotfiles like .mcp.json).
  let entries: StagedEntry[] = Object.entries(unzipped)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path: path.replace(/\\/g, "/"), data }))
    .filter((e) => !e.path.split("/").some((seg) => seg === ".git" || seg === "__MACOSX"));
  if (entries.length === 0) throw new Error("the zip is empty");

  // GitHub always adds a single root folder (owner-repo-sha/…) — strip it.
  const roots = new Set(entries.map((e) => e.path.split("/")[0]));
  if (roots.size === 1 && entries.every((e) => e.path.includes("/"))) {
    const root = [...roots][0] as string;
    entries = entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) }));
  }

  // Optional subfolder filter (a monorepo of plugins).
  if (subfolder) {
    const prefix = subfolder.replace(/^\/|\/$/g, "") + "/";
    const sub = entries.filter((e) => e.path.startsWith(prefix)).map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
    if (sub.length === 0) throw new Error(`subfolder "${subfolder}" not found in the repo`);
    entries = sub;
  }

  return stageEntries(entries);
}
