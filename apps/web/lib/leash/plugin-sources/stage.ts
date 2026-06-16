/**
 * Plugin source staging (server-only) — the shared helpers every `PluginSource` uses to land an
 * extracted plugin tree in a temp dir, which `installStagedPlugin` then validates + adopts.
 *
 * A `PluginSource` resolves a spec → `{ stagedDir, cleanup() }`; the install choke-point does the
 * rest (always → disabled). Keeping ALL the source-specific logic behind this one shape is what lets
 * the four distribution channels (folder, github/upload, mesh, marketplace) layer incrementally.
 */
import "server-only";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** A staged plugin tree on disk + the caller's responsibility to remove it after install. */
export interface StagedPlugin {
  /** Absolute path to the extracted tree (validated by `installStagedPlugin`). */
  stagedDir: string;
  /** Remove the staged tree (best-effort; safe to call when the dir is already gone or owned elsewhere). */
  cleanup: () => Promise<void>;
}

/** One file extracted from an archive/folder: a POSIX-ish relative path + its bytes. */
export interface StagedEntry {
  path: string;
  data: Uint8Array;
}

/** Caps applied while writing an archive into a staged dir (install re-checks the materialized tree). */
const MAX_ENTRIES = 1000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** A single safe path segment (no separators). */
const SAFE_SEG = /^[^/\\]+$/;

/**
 * Validate + normalize one archive entry path: not absolute, no `.`/`..`/empty segment, ≤10 deep,
 * bounded length. Returns the normalized POSIX path or null (rejected). Unlike the skills'
 * `safeRelPath`, this ALLOWS dotfiles/dotdirs (a plugin needs `.claude-plugin/` and `.mcp.json`).
 */
export function safeEntryPath(p: string): string | null {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  if (!norm || norm.length > 400) return null;
  const segs = norm.split("/");
  if (segs.length > 10) return null;
  for (const s of segs) if (s === "" || s === "." || s === ".." || !SAFE_SEG.test(s)) return null;
  return segs.join("/");
}

/** Make a fresh temp dir for staging (caller cleans up via the returned `StagedPlugin.cleanup`). */
export async function makeStagingDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "leash-plugin-"));
}

/** A `cleanup` that recursively removes `dir` (best-effort). */
export function rmCleanup(dir: string): () => Promise<void> {
  return async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  };
}

/**
 * Write extracted `entries` into a fresh staging dir, sanitizing every path. Throws on an unsafe
 * path or a busted cap (better to fail the install than adopt a malformed tree). Returns the
 * `StagedPlugin` (its cleanup removes the staging dir).
 */
export async function stageEntries(entries: StagedEntry[]): Promise<StagedPlugin> {
  if (entries.length === 0) throw new Error("the bundle is empty");
  if (entries.length > MAX_ENTRIES) throw new Error(`the bundle has too many files (${entries.length} > ${MAX_ENTRIES})`);
  const dir = await makeStagingDir();
  let bytes = 0;
  try {
    for (const e of entries) {
      const rel = safeEntryPath(e.path);
      if (!rel) throw new Error(`unsafe path in bundle: "${e.path}"`);
      bytes += e.data.byteLength;
      if (bytes > MAX_TOTAL_BYTES) throw new Error(`the bundle is too large (> ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB)`);
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, e.data);
    }
  } catch (err) {
    await rmCleanup(dir)();
    throw err;
  }
  return { stagedDir: dir, cleanup: rmCleanup(dir) };
}
