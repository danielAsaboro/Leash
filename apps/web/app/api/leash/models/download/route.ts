/**
 * `POST /api/leash/models/download` `{ name }` — start a model download as a DETACHED
 * tsx child (survives Next dev restarts; the SDK lives in the child, never in Next).
 * `GET ?name=X` — poll one status file. `GET` (no name) — all download states.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR } from "../../../../../lib/leash/json-store.ts";
import { readCatalog, readDownload, listDownloads, downloadPidAlive } from "../../../../../lib/leash/models.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = join(DATA_DIR, "..");
const SCRIPT = join(ROOT, "apps", "web", "scripts", "leash-model-download.mts");

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
  if (!name || !/^[A-Z0-9_]+$/.test(name)) return Response.json({ error: "name must be an SDK constant (e.g. QWEN3_600M_INST_Q4)" }, { status: 400 });
  const catalog = await readCatalog();
  if (!catalog.some((c) => c.name === name)) return Response.json({ error: `"${name}" is not in the SDK catalog` }, { status: 404 });

  const existing = await readDownload(name);
  if (existing && (existing.state === "downloading" || existing.state === "starting") && downloadPidAlive(existing.pid)) {
    return Response.json({ ok: true, alreadyRunning: true, status: existing });
  }

  // Detached + unref: the download keeps going if Next dev restarts; state lives in
  // the status file, not in a held process handle (stateless supervision).
  const child = spawn("npx", ["tsx", SCRIPT, name], { cwd: ROOT, detached: true, stdio: "ignore" });
  child.unref();
  return Response.json({ ok: true, pid: child.pid }, { status: 202 });
}
