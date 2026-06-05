/**
 * `POST /api/leash/research` `{ question }` — start a deep-research run as a DETACHED
 * tsx child (SDK lives in the child; survives Next restarts). `GET` — list all runs.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { generateId } from "ai";
import { DATA_DIR } from "../../../../lib/leash/json-store.ts";
import { listResearch } from "../../../../lib/leash/research-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = join(DATA_DIR, "..");
const SCRIPT = join(ROOT, "apps", "web", "scripts", "leash-research.mts");

export async function GET(): Promise<Response> {
  return Response.json({ runs: await listResearch() });
}

export async function POST(req: Request): Promise<Response> {
  const { question } = (await req.json()) as { question?: string };
  const q = question?.trim();
  if (!q) return Response.json({ error: "question is required" }, { status: 400 });
  const id = generateId();
  // Detached + unref: research keeps running if Next dev restarts; the dashboard polls
  // the status file. This is an ONLINE feature — it needs network for web search.
  const child = spawn("npx", ["tsx", SCRIPT, id, q.slice(0, 500)], { cwd: ROOT, detached: true, stdio: "ignore" });
  child.unref();
  return Response.json({ ok: true, id, pid: child.pid }, { status: 202 });
}
