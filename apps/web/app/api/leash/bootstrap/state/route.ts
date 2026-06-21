import { NextResponse } from "next/server";
import { readDeviceBootstrap } from "../../../../../lib/leash/device-bootstrap.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ bootstrap: readDeviceBootstrap() });
}
