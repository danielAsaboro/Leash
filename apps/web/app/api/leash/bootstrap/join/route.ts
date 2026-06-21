import { NextResponse } from "next/server";
import { createDeviceIdentity } from "../../../../../lib/leash/device-bootstrap-core.ts";
import { readDeviceBootstrap, startBootstrap } from "../../../../../lib/leash/device-bootstrap.ts";
import { requestRespawn } from "../../../../../lib/leash/supervisor.ts";

export const runtime = "nodejs";

const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);

export async function POST(req: Request): Promise<NextResponse> {
  const { invite, label } = (await req.json().catch(() => ({}))) as { invite?: unknown; label?: unknown };
  if (typeof invite !== "string" || invite.trim().length < 16) {
    return NextResponse.json({ error: "A full device invite is required." }, { status: 400 });
  }

  const trimmedInvite = invite.trim();
  const trimmedLabel = typeof label === "string" && label.trim().length > 0 ? label.trim() : "Mesh";
  const bootstrap = readDeviceBootstrap();

  if (!bootstrap?.identity?.userId) {
    const identity = createDeviceIdentity("imported", Date.now());
    const next = startBootstrap("sync-existing", identity);
    requestRespawn({ userId: identity.userId });
    return NextResponse.json({
      ok: true,
      needsRespawn: true,
      switchTo: identity.userId,
      bootstrap: next,
    });
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${HYPHA_PORT}/mesh/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: trimmedInvite, label: trimmedLabel }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const text = await resp.text();
    if (!resp.ok) return new NextResponse(text || JSON.stringify({ error: "Join failed." }), { status: resp.status, headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "Hypha daemon not running — start it on the Services page." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, needsRespawn: false, joined: true });
}
