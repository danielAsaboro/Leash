/**
 * `GET /api/leash/downloads` — every download (model weights + system runtime/daemon overlay),
 * unified for the Tasks → Downloads view. Polled by the Tasks page, so progress + failures stay
 * visible no matter which page you're on (unlike the Models panel, which only polled while mounted).
 *
 * `POST { name, kind }` — retry a failed/stalled download:
 *   · kind "model"  → re-spawn the detached download child (same path as /models/download).
 *   · kind "system" → write a retry sentinel the Electron main polls (it owns the runtime/daemon fetch).
 */
import { listAllDownloads, readCatalog, readDownload, downloadPidAlive, requestSystemControl, cancelDownload } from "../../../../lib/leash/models.ts";
import { spawnHelperScript } from "../../../../lib/leash/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ downloads: await listAllDownloads() });
}

export async function POST(req: Request): Promise<Response> {
  const { name, kind, action } = (await req.json()) as { name?: string; kind?: "model" | "system"; action?: "retry" | "cancel" };
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  // System downloads (runtime / daemon overlay) are owned by the Electron main — signal it via a sentinel.
  if (kind === "system") {
    const ok = await requestSystemControl(name, action === "cancel" ? "cancel" : "retry");
    return ok ? Response.json({ ok: true }) : Response.json({ error: "no system download dir" }, { status: 400 });
  }

  if (action === "cancel") {
    await cancelDownload(name);
    return Response.json({ ok: true, cancelled: true });
  }

  // model retry/start — mirror /models/download POST
  if (!/^[A-Z0-9_]+$/.test(name)) return Response.json({ error: "model name must be an SDK constant" }, { status: 400 });
  const catalog = await readCatalog();
  if (!catalog.some((c) => c.name === name)) return Response.json({ error: `"${name}" is not in the SDK catalog` }, { status: 404 });
  const existing = await readDownload(name);
  if (existing && (existing.state === "downloading" || existing.state === "starting") && downloadPidAlive(existing.pid)) {
    return Response.json({ ok: true, alreadyRunning: true });
  }
  const child = spawnHelperScript("leash-model-download.mts", [name], { detached: true, stdio: "ignore" });
  child.unref();
  return Response.json({ ok: true, pid: child.pid }, { status: 202 });
}
