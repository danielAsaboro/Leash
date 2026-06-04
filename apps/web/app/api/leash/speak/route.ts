/**
 * `POST /api/leash/speak` — on-device "read aloud" for an assistant answer.
 *
 * Relays text to the local `qvac serve openai` speech endpoint (supertonic TTS, served
 * from `qvac.config.json`) and streams the WAV straight back to the browser. Pure HTTP,
 * on-device, no `@qvac/sdk` in Next — same pattern as the chat route.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const TTS_MODEL = process.env["LEASH_TTS_MODEL"] ?? "supertonic";

export async function POST(req: Request): Promise<Response> {
  const { text } = (await req.json()) as { text?: string };
  const input = (text ?? "").trim();
  if (!input) return new Response(JSON.stringify({ error: "missing text" }), { status: 400, headers: { "content-type": "application/json" } });

  try {
    const upstream = await fetch(`${QVAC_OPENAI_URL}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, input: input.slice(0, 4000), response_format: "wav" }),
    });
    if (!upstream.ok || !upstream.body) {
      return new Response(JSON.stringify({ error: `tts ${upstream.status}` }), { status: 502, headers: { "content-type": "application/json" } });
    }
    return new Response(upstream.body, { status: 200, headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch {
    return new Response(JSON.stringify({ error: "tts offline" }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
