/**
 * Bounded filesystem snapshot (PURE — no `server-only`, no Next imports) — shared by the
 * out-of-process bash child (`scripts/bash-exec.mts`). just-bash CANNOT run inside Next's
 * RSC runtime (its Error.prepareStackTrace guard crashes the process — verified 2026-06-11),
 * so the sandbox runs in a spawned `tsx` child; this module is the snapshot logic the child
 * uses to load the user's files into the in-memory FS.
 *
 * Home is enormous, so the walk is hard-bounded: cap file count + per-file + total bytes,
 * cap directory entries scanned, skip junk dirs and binaries.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

export const SNAPSHOT_CAPS = {
  maxFiles: 600,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxScan: 20_000,
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", "Library", "Applications", ".Trash", ".cache", "Caches",
  "dist", "build", "out", "coverage", "vendor", "target", ".venv", "venv", "env", "__pycache__",
  ".gradle", ".npm", ".cargo", ".rustup", "go", ".terraform", "DerivedData", ".cocoapods", ".bun", ".pnpm-store",
]);
const TEXT_EXT = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".text", ".rst", ".org", ".tex",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonl", ".json5",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift",
  ".php", ".pl", ".lua", ".r", ".scala", ".clj", ".ex", ".exs", ".erl", ".hs", ".ml", ".dart",
  ".sql", ".graphql", ".gql", ".proto", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".svelte", ".vue", ".astro", ".csv", ".tsv", ".log", ".diff", ".patch",
]);
const DOTFILE_RE = /^\.(env|gitignore|dockerignore|npmrc|nvmrc|editorconfig|prettierrc|eslintrc|zshrc|bashrc|profile)/;

export interface SnapshotStats {
  root: string;
  included: number;
  scanned: number;
  truncated: boolean;
  bytes: number;
}
export interface Snapshot extends SnapshotStats {
  files: Record<string, string>;
}

/** Breadth-first, bounded walk of `root` → a `{ relpath: content }` map of text files. */
export async function buildSnapshot(root: string): Promise<Snapshot> {
  const { maxFiles, maxFileBytes, maxTotalBytes, maxScan } = SNAPSHOT_CAPS;
  const files: Record<string, string> = {};
  let included = 0;
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  const queue: string[] = [root];

  while (queue.length > 0 && included < maxFiles && scanned < maxScan) {
    const dir = queue.shift() as string;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const e of entries) {
      if (included >= maxFiles || scanned >= maxScan) {
        truncated = true;
        break;
      }
      scanned++;
      const name = e.name;
      if (e.isDirectory()) {
        if (!name.startsWith(".") && !SKIP_DIRS.has(name)) queue.push(join(dir, name));
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (!TEXT_EXT.has(ext) && !DOTFILE_RE.test(name)) continue;
      const abs = join(dir, name);
      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      if (size > maxFileBytes || bytes + size > maxTotalBytes) {
        truncated = true;
        continue;
      }
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // NUL byte means binary, skip
      files[relative(root, abs)] = content;
      included++;
      bytes += size;
    }
  }
  return { root, files, included, scanned, bytes, truncated: truncated || included >= maxFiles };
}
