/**
 * The source → install glue (server-only). Every install route stages a tree via its `PluginSource`,
 * hands it to the single `installStagedPlugin` choke-point (always → disabled), and cleans the staging
 * dir — on success AND failure. Returns the HTTP Response so routes stay one-liners.
 */
import "server-only";
import { installStagedPlugin } from "../plugins-store.ts";
import type { PluginSourceRef } from "../plugin-manifest.ts";
import type { StagedPlugin } from "./stage.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Stage (via `stage`), install under `source`, clean up; map errors to `{error}` + status. */
export async function stageAndInstall(source: PluginSourceRef, stage: () => Promise<StagedPlugin>): Promise<Response> {
  let staged: StagedPlugin;
  try {
    staged = await stage();
  } catch (e) {
    return Response.json({ error: msg(e) }, { status: 400 });
  }
  try {
    const plugin = await installStagedPlugin(staged.stagedDir, source);
    return Response.json({ plugin }, { status: 201 });
  } catch (e) {
    const status = (e as Error & { code?: string }).code === "exists" ? 409 : 400;
    return Response.json({ error: msg(e) }, { status });
  } finally {
    await staged.cleanup();
  }
}
