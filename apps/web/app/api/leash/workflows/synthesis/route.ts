import { start } from "workflow/api";
import { z } from "zod";
import { QVAC_OPENAI_URL, UTILITY_MODEL } from "../../../../../lib/leash/provider.ts";
import { durableSynthesis } from "../../../../../workflows/durable-synthesis.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  maxOutputTokens: z.number().int().min(80).max(1_200).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_workflow_input", issues: parsed.error.issues }, { status: 400 });
  const run = await start(durableSynthesis, [{
    ...parsed.data,
    baseURL: QVAC_OPENAI_URL,
    model: UTILITY_MODEL,
  }]);
  return Response.json({ runId: run.runId, status: await run.status }, { status: 202 });
}
