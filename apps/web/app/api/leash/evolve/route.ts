/**
 * `GET /api/leash/evolve` — the growth-chart series: paired base-vs-adapter eval runs
 * plus the latest adapter's manifest + per-axis deltas. Pure file read (no corestore,
 * no model), so it's always safe to hit even while a serve holds the GPU.
 */
import { buildSeries } from "../../../../lib/leash/evolve.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(buildSeries());
}
