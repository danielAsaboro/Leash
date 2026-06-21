import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateText, uploadFile } from "ai";
import { createQvac } from "@mycelium/leash-core/qvac-provider";

const baseURL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const provider = createQvac({ baseURL, apiKey: "qvac" });
const bytes = await readFile(new URL("../spike/fixtures/ocr-note.png", import.meta.url));
const uploaded = await uploadFile({
  api: provider,
  data: bytes,
  mediaType: "image/png",
  filename: "greenhouse-sensor.png",
  providerOptions: { qvac: { purpose: "assistants" } },
});
assert.match(uploaded.providerReference.qvac ?? "", /^file-/, "QVAC returned a local file reference");

const result = await generateText({
  model: provider("vision"),
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Read the greenhouse temperature and batch ID exactly." },
      { type: "file", mediaType: "image/png", data: uploaded.providerReference },
    ],
  }],
  maxOutputTokens: 120,
});
assert.match(result.text, /24/, "vision result includes the temperature");
assert.match(result.text, /QV-2026-0601/i, "vision result includes the batch id");
console.log(JSON.stringify({ providerReference: uploaded.providerReference, text: result.text, usage: result.usage }, null, 2));
console.log("smoke:qvac-provider-files-live PASS");
