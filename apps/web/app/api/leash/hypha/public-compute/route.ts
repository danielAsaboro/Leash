export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BASE = `http://127.0.0.1:${Number(process.env["HYPHA_PORT"] ?? 11437)}`;

async function proxy(path: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    return new Response(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ ok: false, error: "Hypha daemon not running." }, { status: 503 });
  }
}
export async function GET(): Promise<Response> { return proxy("/public/compute"); }
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxy("/public/compute/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
