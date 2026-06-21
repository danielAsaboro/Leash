import { NextResponse } from "next/server";
import { finishBootstrap } from "../../../../../lib/leash/device-bootstrap.ts";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const bootstrap = finishBootstrap();
  return NextResponse.json({ ok: true, bootstrap });
}
