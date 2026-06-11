/**
 * Pure round-trip smoke for the shim's multipart parser (apps/hypha/src/multipart-parse.ts). Builds a
 * real multipart/form-data body with the platform FormData (what an OpenAI client sends to
 * /v1/audio/transcriptions), then parses it back and asserts the model field + the binary file bytes
 * survive intact. No network, no SDK.
 *
 *   npm run smoke:multipart
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parseMultipart, boundaryOf } from "../apps/hypha/src/multipart-parse.ts";

async function main(): Promise<void> {
  // A binary "audio" payload that includes bytes which could trip a naive string splitter.
  const audio = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46, 0x0d, 0x0a, 0x2d, 0x2d]), randomBytes(4096)]);
  const form = new FormData();
  form.append("model", "parakeet");
  form.append("response_format", "json");
  form.append("file", new Blob([audio], { type: "audio/wav" }), "clip.wav");

  const req = new Request("http://x/v1/audio/transcriptions", { method: "POST", body: form });
  const ct = req.headers.get("content-type") ?? "";
  const boundary = boundaryOf(ct);
  assert.ok(boundary, `no boundary parsed from "${ct}"`);
  const body = Buffer.from(await req.arrayBuffer());

  const parts = parseMultipart(body, boundary!);
  const model = parts.find((p) => p.name === "model");
  const fmt = parts.find((p) => p.name === "response_format");
  const file = parts.find((p) => p.name === "file");

  assert.equal(model?.data.toString("utf8"), "parakeet", "model field");
  assert.equal(fmt?.data.toString("utf8"), "json", "response_format field");
  assert.ok(file, "file part missing");
  assert.equal(file!.filename, "clip.wav", "filename");
  assert.equal(file!.contentType, "audio/wav", "file content-type");
  assert.ok(file!.data.equals(audio), `file bytes corrupted (${file!.data.length} vs ${audio.length})`);

  console.log(`✅ multipart — boundary parsed, model="parakeet", file "clip.wav" (${file!.data.length} bytes) round-trips byte-identical — GO`);
}

main().catch((e) => {
  console.error("❌ smoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
