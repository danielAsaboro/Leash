/**
 * `POST /api/leash/transcribe` — on-device speech-to-text for voice input.
 *
 * Relays the uploaded audio (multipart `file`) to the local `qvac serve openai`
 * transcription endpoint (Parakeet, served from `qvac.config.json`) and returns the
 * recognized `{ text }`. Pure HTTP, on-device, no `@qvac/sdk` in Next — same pattern
 * as the chat/speak routes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const STT_MODEL = process.env["LEASH_STT_MODEL"] ?? "parakeet";

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "missing audio file" }, { status: 400 });
    }
    const name = file instanceof File && file.name ? file.name : "speech.webm";
    const upstream = new FormData();
    upstream.append("file", file, name);
    upstream.append("model", STT_MODEL);

    const res = await fetch(`${QVAC_OPENAI_URL}/audio/transcriptions`, { method: "POST", body: upstream });
    if (!res.ok) {
      return Response.json({ error: `transcription failed (${res.status})` }, { status: 502 });
    }
    const data = (await res.json()) as { text?: string };
    return Response.json({ text: (data.text ?? "").trim() });
  } catch {
    return Response.json({ error: "transcription offline" }, { status: 502 });
  }
}
