/**
 * `DELETE /api/leash/models/file/[file]` — delete one cached model file from
 * ~/.qvac/models. GUARDED:
 *   · refused if the file backs a config alias that is LIVE (READY) right now
 *   · refused if it backs any config alias at all, unless `?force=1` (the UI
 *     confirms first — deleting a configured model breaks the next restart)
 */
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { QVAC_MODELS_DIR, modelsInventory } from "../../../../../../lib/leash/models.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const name = basename(decodeURIComponent(file)); // no path traversal
  const force = new URL(req.url).searchParams.get("force") === "1";

  const inventory = await modelsInventory();
  const backing = inventory.configured.filter((r) => r.cacheFile === name);
  const liveAliases = backing.filter((r) => r.loaded).map((r) => r.alias);
  if (liveAliases.length > 0) {
    return Response.json({ error: `"${name}" backs LIVE model(s): ${liveAliases.join(", ")} — unload first` }, { status: 409 });
  }
  if (backing.length > 0 && !force) {
    return Response.json(
      { error: `"${name}" is referenced by config alias(es): ${backing.map((r) => r.alias).join(", ")} — pass force=1 to delete anyway`, needsForce: true },
      { status: 409 },
    );
  }
  const onDisk = [...inventory.configured, ...inventory.onDiskOnly].some((r) => r.cacheFile === name && r.onDiskBytes !== null);
  if (!onDisk) return Response.json({ error: `"${name}" is not in the model cache` }, { status: 404 });

  await rm(join(QVAC_MODELS_DIR, name));
  return Response.json({ ok: true });
}
