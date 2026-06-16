/**
 * Upload plugin source (server-only) — stage a plugin from an uploaded `.zip`'s bytes.
 *
 * Unzip → strip a single common root folder (some zips wrap the tree, some don't) → stage. Same
 * extraction shape as the GitHub source, minus the network fetch.
 */
import "server-only";
import { unzipSync } from "fflate";
import { stageEntries, type StagedPlugin, type StagedEntry } from "./stage.ts";

const MAX_ZIP_BYTES = 25 * 1024 * 1024;

/** Extract an uploaded zip into a staged plugin tree. */
export async function stageFromUploadZip(zip: Uint8Array): Promise<StagedPlugin> {
  if (zip.byteLength > MAX_ZIP_BYTES) throw new Error(`zip too large (${Math.round(zip.byteLength / 1024 / 1024)} MB > ${MAX_ZIP_BYTES / 1024 / 1024} MB)`);
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zip);
  } catch (err) {
    throw new Error(`couldn't read the zip: ${err instanceof Error ? err.message : String(err)}`);
  }
  let entries: StagedEntry[] = Object.entries(unzipped)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path: path.replace(/\\/g, "/"), data }))
    .filter((e) => !e.path.split("/").some((seg) => seg === ".git" || seg === "__MACOSX"));
  if (entries.length === 0) throw new Error("the zip is empty");

  // Strip a single wrapping root folder if EVERY entry shares it (and none lives at the root).
  const roots = new Set(entries.map((e) => e.path.split("/")[0]));
  if (roots.size === 1 && entries.every((e) => e.path.includes("/"))) {
    const root = [...roots][0] as string;
    // Only strip when the wrapper isn't itself a plugin component dir (don't eat `skills/`).
    if (!["skills", "agents", ".claude-plugin"].includes(root)) {
      entries = entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) }));
    }
  }
  return stageEntries(entries);
}
