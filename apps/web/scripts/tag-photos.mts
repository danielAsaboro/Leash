/**
 * #3 — Auto-tag the user's images, on-device. Classifies every photo in `data/photos`
 * with the bundled GGML MobileNetV3 (`classify()`, no download) and writes
 * `data/leash-photo-tags.json` — a `{file,label,confidence,isDocument}[]` the assistant
 * (and a future graph-ingest step) can use to surface/organize images.
 *
 *   npm run tag-photos
 */
import { loadClassifier, unloadClassifier, classifyImage } from "@mycelium/senses";
import { close } from "@qvac/sdk";
import { readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", ".."); // apps/web/scripts → repo root
const PHOTOS = process.env["LEASH_PHOTOS_DIR"] ?? join(ROOT, "data", "photos");
const OUT = process.env["LEASH_PHOTO_TAGS"] ?? join(ROOT, "data", "leash-photo-tags.json");

async function main(): Promise<void> {
  mkdirSync(dirname(OUT), { recursive: true });
  if (!existsSync(PHOTOS)) {
    writeFileSync(OUT, "[]");
    console.log(`🏷  no photos dir at ${PHOTOS} — wrote empty tags.`);
    return;
  }
  const files = readdirSync(PHOTOS).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (files.length === 0) {
    writeFileSync(OUT, "[]");
    console.log("🏷  no images to tag.");
    return;
  }
  console.log(`🏷  tagging ${files.length} image(s) with on-device classify()…`);
  const cls = await loadClassifier();
  const out: Array<{ file: string; label: string; confidence: number; isDocument: boolean; all: { label: string; confidence: number }[] }> = [];
  for (const f of files) {
    const { top, all, isDocument } = await classifyImage({ classifierModelId: cls, imagePath: join(PHOTOS, f) });
    out.push({ file: f, label: top.label, confidence: top.confidence, isDocument, all });
    console.log(`   ${f} → ${top.label} (${Math.round(top.confidence * 100)}%)${isDocument ? " · document" : ""}`);
  }
  await unloadClassifier(cls);
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`🏷  wrote ${out.length} tag(s) → ${OUT}`);
  await close();
}

main().catch((err) => {
  console.error("❌ tag-photos failed:", err);
  process.exit(1);
});
