/**
 * Probe whether a qvac serve handles OpenAI `image_url` content → vision (i.e. the serve-image patch
 * is applied). POSTs a real image as a base64 data-URL to <SERVE_URL>/v1/chat/completions and prints
 * the caption. Used to gate the SP2 Option B forward path: the provider runs forwarded vision on its
 * LOCAL serve, so that serve must be vision-capable.
 *
 *   SERVE_URL=http://127.0.0.1:11435 tsx scripts/probe-serve-vision.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SERVE_URL = (process.env["SERVE_URL"] ?? "http://127.0.0.1:11435").replace(/\/+$/, "");
const MODEL = process.env["VISION_MODEL"] ?? "qwen3vl";
const IMG = ["spike/fixtures/ocr-note.png", "data/photos/calibration-card.png"].map((p) => join(process.cwd(), p)).find(existsSync);

async function main(): Promise<void> {
  if (!IMG) throw new Error("no image fixture found (spike/fixtures/ocr-note.png)");
  const dataUrl = "data:image/png;base64," + readFileSync(IMG).toString("base64");
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "What is in this image? Answer in one short sentence." }, { type: "image_url", image_url: { url: dataUrl } }] }],
    stream: false,
  };
  console.log(`→ POST ${SERVE_URL}/v1/chat/completions  (model=${MODEL}, img=${IMG.split("/").pop()})`);
  const t0 = Date.now();
  const res = await fetch(`${SERVE_URL}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) {
    console.error(`❌ serve ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`);
    process.exit(1);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const caption = (json.choices?.[0]?.message?.content ?? "").trim();
  console.log(`← (${secs}s) caption: "${caption}"`);
  if (!caption) {
    console.error("⛔ EMPTY caption — the serve did NOT run vision (image_url dropped → serve not patched).");
    process.exit(2);
  }
  console.log("✅ serve handled image_url → vision (patch active).");
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
