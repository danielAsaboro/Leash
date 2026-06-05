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

    let res: Response;
    try {
      res = await fetch(`${QVAC_OPENAI_URL}/audio/transcriptions`, { method: "POST", body: upstream });
    } catch {
      return Response.json({ error: "The on-device speech service is offline. Start it with `npm run qvac`.", code: "offline" }, { status: 503 });
    }
    if (!res.ok) {
      let detail: { error?: { message?: string; code?: string } } = {};
      try {
        detail = (await res.json()) as typeof detail;
      } catch {
        /* non-JSON error body */
      }
      const code = detail.error?.code ?? `http_${res.status}`;
      const message =
        code === "model_not_found"
          ? `The transcription model "${STT_MODEL}" isn't loaded. Add it to qvac.config.json → serve.models and restart \`npm run qvac\`.`
          : detail.error?.message ?? `Transcription failed (HTTP ${res.status}).`;
      return Response.json({ error: message, code }, { status: 502 });
    }
    const data = (await res.json()) as { text?: string };
    return Response.json({ text: (data.text ?? "").trim() });
  } catch {
    return Response.json({ error: "Couldn't process the recording.", code: "internal" }, { status: 500 });
  }
}
