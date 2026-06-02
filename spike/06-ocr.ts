/**
 * Spike 06 — prove on-device OCR (Part D gate). GO/NO-GO before any package code.
 *
 *   npm run spike:ocr
 *
 * Loads the ONNX OCR recognizer via modelType:"ocr" and runs ocr({modelId, image}) on a
 * REAL rasterized-text fixture, asserting the known text is extracted — fully on-device,
 * offline after warm-cache. Config mirrors the SDK's bundled examples/ocr-fasttext.js
 * (the recognizer bundles detection; no separate detector model is wired). Records timing.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, unloadModel, ocr, close } from "@qvac/sdk";
// @ts-ignore — OCR constant is a runtime export absent from @qvac/sdk's root .d.ts.
import { OCR_LATIN_RECOGNIZER_1 } from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const IMG = join(here, "fixtures", "ocr-note.png");
const audit = new AuditLog("06-ocr");
const EXPECT = ["greenhouse", "24", "QV-2026-0601"]; // tokens that must appear (case-insensitive substring)

try {
  console.log(`\n🔤 OCR (OCR_LATIN_RECOGNIZER_1, modelType:"ocr") on ${IMG}`);
  const t0 = now();
  const modelId = await loadModel({
    modelSrc: OCR_LATIN_RECOGNIZER_1,
    modelType: "ocr",
    modelConfig: { langList: ["en"], useGPU: true, magRatio: 1.5, defaultRotationAngles: [90, 180, 270], contrastRetry: false, lowConfidenceThreshold: 0.5, recognizerBatchSize: 1 },
    onProgress: () => {},
  } as Parameters<typeof loadModel>[0]);
  audit.record({ event: "model_load", modelId, extra: { phase: "ocr-load" } });

  const { blocks, stats } = ocr({ modelId, image: IMG, options: { paragraph: false } } as Parameters<typeof ocr>[0]);
  const all = await blocks;
  const text = all.map((b) => b.text).join(" ");
  const s = await stats;
  console.log(`   blocks: ${all.length}`);
  console.log(`   text: "${text.replace(/\s+/g, " ").slice(0, 300)}"`);
  audit.record({ event: "note", durationMs: now() - t0, extra: { role: "ocr", blocks: all.length, chars: text.length, totalTimeMs: s?.totalTime } });
  await unloadModel({ modelId });

  const missing = EXPECT.filter((tok) => !text.toLowerCase().includes(tok.toLowerCase()));
  if (missing.length) throw new Error(`OCR missing expected token(s) [${missing.join(", ")}]. Got: "${text}"`);
  audit.record({ event: "note", extra: { role: "ocr-gate", won: "recognizer", blocks: all.length } });
  console.log(`\n✅ OCR GO — extracted all expected tokens on-device. Log: ${audit.path}`);
  await close();
} catch (error) {
  console.error("❌ OCR spike failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  await close();
  process.exit(1);
}
