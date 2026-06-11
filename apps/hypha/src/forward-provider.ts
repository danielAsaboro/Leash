import type { AuditLog } from "@mycelium/shared";
import type { ForwardRequest, ForwardFrame } from "./forward-control.ts";
import { LOCAL_SERVE_URL } from "./config.ts";
import { billableUsage, wavDurationSeconds } from "./forward-metering.ts";

// Provider-side forward handler (SP2 Option B). A forwarded OpenAI request arrives over P2P with its
// media INLINE in the body (base64 data-URLs); we proxy it to THIS device's local `qvac serve` — the
// one place that turns `image_url` into a vision completion (the serve patch) and already has the
// model resident — then re-emit the serve's response as forward frames. Endpoint-agnostic:
//   - chat/vision     → serve streams OpenAI SSE → emit each token (delta.content) as a chunk frame.
//   - embeddings      → serve returns one JSON body → emit it as a single chunk frame.
//   - audio/speech    → serve returns binary audio → emit base64 chunk frames.
// The consumer's per-endpoint shim handler reassembles.
//
// Why proxy instead of loadModel() in-process: the serve already has the model loaded; a second
// in-hypha load would duplicate it in RAM/GPU (the exact thing the warm pool's fallbackToLocal:false
// avoids), and it would re-implement the materialization the serve already does.

export interface ForwardProviderDeps {
  /** Local OpenAI serve base URL (defaults to LOCAL_SERVE_URL — the broker upstream on :11435). */
  serveUrl?: string;
  audit: AuditLog;
}

interface SseDelta {
  choices?: Array<{ delta?: { content?: string } }>;
  error?: string | { message?: string };
}

/** Build the forward handler that proxies to the local serve and streams frames back. */
export function createForwardProvider(deps: ForwardProviderDeps): (req: ForwardRequest, send: (frame: ForwardFrame) => void) => Promise<void> {
  const serveUrl = (deps.serveUrl ?? LOCAL_SERVE_URL).replace(/\/+$/, "");
  return async (req, send) => {
    const url = serveUrl + req.endpoint;
    const isChat = req.endpoint.includes("/chat/completions");
    const isTranscription = req.endpoint.includes("/audio/transcriptions");
    const inBody = (req.body as Record<string, unknown>) ?? {};
    let res: Response;
    let sttDurationSeconds: number | undefined; // STT is billed per audio-second (B4)
    try {
      if (isTranscription) {
        // STT uploads a file: rebuild the multipart form the serve expects from the inline base64 audio.
        const audio = Buffer.from(String(inBody["audio_base64"] ?? ""), "base64");
        sttDurationSeconds = wavDurationSeconds(audio);
        const form = new FormData();
        form.append("model", String(inBody["model"] ?? ""));
        form.append("file", new Blob([audio]), String(inBody["filename"] ?? "audio.wav"));
        for (const k of ["response_format", "language", "prompt", "temperature"]) {
          if (inBody[k] !== undefined) form.append(k, String(inBody[k]));
        }
        res = await fetch(url, { method: "POST", body: form }); // fetch sets the multipart content-type + boundary
      } else {
        // Chat streams as SSE (a long vision decode reaches the consumer incrementally); embeddings/speech
        // return a single JSON or binary body. Serve bodies are passthrough, so consumer fields ride along.
        const payload = isChat ? { ...inBody, stream: true } : inBody;
        res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      }
    } catch (e) {
      send({ id: req.id, type: "error", error: `forward-provider: local serve unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const stream = res.body;
    if (!res.ok || stream === null) {
      const detail = await res.text().catch(() => "");
      send({ id: req.id, type: "error", error: `forward-provider: serve ${res.status} ${detail.slice(0, 200)}` });
      return;
    }
    deps.audit.record({ event: "note", extra: { role: "forward", phase: "provider-serve-open", id: req.id, endpoint: req.endpoint, status: res.status } });
    try {
      if (isChat) await streamSse(req, stream, send);
      else await relayBody(req, res.headers.get("content-type") ?? "", stream, send, sttDurationSeconds);
    } catch (e) {
      send({ id: req.id, type: "error", error: `forward-provider: stream error: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
}

/** Chat: parse the serve's OpenAI SSE and emit each token (delta.content) as a chunk frame. */
async function streamSse(req: ForwardRequest, body: ReadableStream<Uint8Array>, send: (frame: ForwardFrame) => void): Promise<void> {
  const reqBody = (req.body as Record<string, unknown>) ?? {};
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokens = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
      if (dataLine === undefined) continue;
      const payload = dataLine.slice("data:".length).trim();
      if (payload === "[DONE]") { send({ id: req.id, type: "done", stats: { tokens, usage: billableUsage(req.endpoint, reqBody, { tokens }) } }); return; }
      let frame: SseDelta;
      try { frame = JSON.parse(payload) as SseDelta; } catch { continue; }
      if (frame.error !== undefined) {
        const message = typeof frame.error === "string" ? frame.error : (frame.error.message ?? "serve error");
        send({ id: req.id, type: "error", error: `forward-provider: ${message}` });
        return;
      }
      const token = frame.choices?.[0]?.delta?.content;
      if (typeof token === "string" && token.length > 0) { tokens++; send({ id: req.id, type: "chunk", data: token }); }
    }
  }
  send({ id: req.id, type: "done", stats: { tokens, usage: billableUsage(req.endpoint, reqBody, { tokens }) } });
}

/** Non-chat: a JSON/text body (embeddings, transcriptions) → one chunk; a binary body (audio/speech)
 *  → base64 chunk frames. The consumer's per-endpoint handler reassembles. */
async function relayBody(req: ForwardRequest, contentType: string, stream: ReadableStream<Uint8Array>, send: (frame: ForwardFrame) => void, durationSeconds?: number): Promise<void> {
  const isBinary = contentType.startsWith("audio/") || contentType.includes("application/octet-stream");
  const reqBody = (req.body as Record<string, unknown>) ?? {};
  const reader = stream.getReader();
  if (!isBinary) {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    // embeddings (usage.prompt_tokens) / STT (duration) → bill from the parsed JSON, STT falling back to WAV seconds.
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    const usage = billableUsage(req.endpoint, reqBody, { json, ...(durationSeconds !== undefined ? { durationSeconds } : {}) });
    send({ id: req.id, type: "chunk", data: text });
    send({ id: req.id, type: "done", stats: { bytes: text.length, contentType, usage } });
    return;
  }
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.length > 0) { bytes += value.length; send({ id: req.id, type: "chunk", data: Buffer.from(value).toString("base64") }); }
  }
  // TTS (audio/*) → bill the input character count (request-side).
  send({ id: req.id, type: "done", stats: { bytes, contentType, usage: billableUsage(req.endpoint, reqBody, {}) } });
}
