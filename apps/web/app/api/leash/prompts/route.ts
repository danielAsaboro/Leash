/** `GET /api/leash/prompts` (all three, with override state) · `PUT` (set/clear one override). */
import { getPrompts, setPrompt, PROMPT_KEYS, type PromptKey } from "../../../../lib/leash/prompts-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ prompts: await getPrompts() });
}

export async function PUT(req: Request): Promise<Response> {
  const body = (await req.json()) as { key?: PromptKey; value?: string | null };
  if (!body.key || !PROMPT_KEYS.includes(body.key)) return Response.json({ error: "unknown prompt key" }, { status: 400 });
  await setPrompt(body.key, body.value ?? null);
  return Response.json({ prompts: await getPrompts() });
}
