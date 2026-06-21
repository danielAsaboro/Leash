import { NextResponse } from "next/server";
import { createDeviceIdentity } from "../../../../../lib/leash/device-bootstrap-core.ts";
import { readDeviceBootstrap, startBootstrap } from "../../../../../lib/leash/device-bootstrap.ts";
import { requestRespawn } from "../../../../../lib/leash/supervisor.ts";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const current = readDeviceBootstrap();
  if (current?.identity?.userId) {
    return NextResponse.json({ ok: true, switchTo: current.identity.userId, bootstrap: current });
  }

  const identity = createDeviceIdentity("fresh", Date.now());
  const bootstrap = startBootstrap("first-device", identity);
  requestRespawn({ userId: identity.userId });
  return NextResponse.json({ ok: true, switchTo: identity.userId, bootstrap });
}
