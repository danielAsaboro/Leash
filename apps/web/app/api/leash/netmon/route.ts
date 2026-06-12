/**
 * `GET /api/leash/netmon` — backs the offline-proof HUD. Samples the machine's ESTABLISHED
 * TCP sockets (scoped to the QVAC stack) and classifies each remote as loopback / LAN-mesh /
 * cloud. Node runtime (spawns `lsof`), never cached. Returns `ok:false` honestly when the
 * monitor can't run — never a fake `0 cloud`.
 */
import { NextResponse } from "next/server";
import { sampleNetwork } from "../../../../lib/leash/netmon.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await sampleNetwork());
}
