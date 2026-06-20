/**
 * `POST /api/leash/models/download` `{ name }` — start a model download as a DETACHED
 * tsx child (survives Next dev restarts; the SDK lives in the child, never in Next).
 * `GET ?name=X` — poll one status file. `GET` (no name) — all download states.
 */
import { readCatalog, readDownload, listDownloads, downloadPidAlive } from "../../../../../lib/leash/models.ts";
import { spawnHelperScript } from "../../../../../lib/leash/runtime.ts";
import { modelAssetForName } from "@mycelium/brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const name = new URL(req.url).searchParams.get("name");
  if (name) {
    const status = await readDownload(name);
    if (!status) return Response.json({ error: "no such download" }, { status: 404 });
    return Response.json(status);
  }
  return Response.json({ downloads: await listDownloads() });
}

export async function POST(req: Request): Promise<Response> {
  const { name } = (await req.json()) as { name?: string };
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return Response.json({ error: "name must be an SDK constant or shared Brain asset" }, { status: 400 });
  const catalog = await readCatalog();
  if (!catalog.some((c) => c.name === name) && !modelAssetForName(name)) {
    return Response.json({ error: `"${name}" is not in the SDK catalog or shared Brain assets` }, { status: 404 });
  }

  const existing = await readDownload(name);
  if (existing && (existing.state === "downloading" || existing.state === "starting") && downloadPidAlive(existing.pid)) {
    return Response.json({ ok: true, alreadyRunning: true, status: existing });
  }

  // Detached + unref: the download keeps going if Next dev restarts; state lives in
  // the status file, not in a held process handle (stateless supervision). In the packaged
  // app this runs via the bundled qvac runtime (no system node/npx) — see lib/leash/runtime.ts.
  const child = spawnHelperScript("leash-model-download.mts", [name], { detached: true, stdio: "ignore" });
  child.unref();
  return Response.json({ ok: true, pid: child.pid }, { status: 202 });
}
