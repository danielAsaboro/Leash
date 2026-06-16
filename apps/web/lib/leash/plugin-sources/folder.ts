/**
 * Folder plugin source (server-only) — stage a plugin from a local directory.
 *
 * The tree is already on disk, so staging just points at it (a no-op cleanup that never touches the
 * user's folder); `installStagedPlugin` copies it into `PLUGINS_DIR/<id>/` and validates containment.
 * We sanity-check it looks like a plugin first so a wrong path fails with a clear message, not deep
 * inside the install.
 */
import "server-only";
import { stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { StagedPlugin } from "./stage.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Does `dir` look like a Claude-Code plugin (manifest, or any auto-discoverable component dir)? */
async function looksLikePlugin(dir: string): Promise<boolean> {
  for (const probe of [join(dir, ".claude-plugin", "plugin.json"), join(dir, ".mcp.json"), join(dir, "skills"), join(dir, "agents")]) {
    if (await exists(probe)) return true;
  }
  return false;
}

/** Stage a plugin from an absolute local directory. */
export async function stageFromFolder(folderPath: string): Promise<StagedPlugin> {
  const path = folderPath.trim();
  if (!path || !isAbsolute(path)) throw new Error("path must be an absolute directory path");
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new Error(`path not found: "${path}"`);
  }
  if (!st.isDirectory()) throw new Error(`"${path}" is not a directory`);
  if (!(await looksLikePlugin(path))) {
    throw new Error(`"${path}" doesn't look like a plugin (needs a .claude-plugin/plugin.json, .mcp.json, skills/, or agents/)`);
  }
  // Stage in place — installStagedPlugin copies the tree; the original folder is left untouched.
  return { stagedDir: path, cleanup: async () => {} };
}
