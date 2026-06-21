import { getRun } from "workflow/api";
import type { DurableSynthesisResult } from "../../../../../../workflows/durable-synthesis.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await params;
  const run = getRun<DurableSynthesisResult>(runId);
  const status = await run.status;
  const result = status === "completed" ? await run.returnValue : undefined;
  return Response.json({ runId, status, ...(result ? { result } : {}) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await params;
  const run = getRun<DurableSynthesisResult>(runId);
  await run.cancel();
  return Response.json({ runId, status: await run.status });
}
