/**
 * Photo connector (Layer 2 — Senses).
 *
 * On-device OCR via the proven `ocr()` + `OCR_LATIN_RECOGNIZER_1` (`modelType: "ocr"`).
 * The caller appends the extracted text as a `kind:"photo"` graph node, so a whiteboard
 * photo / screenshot / scanned page becomes retrievable context exactly like a note or a
 * voice memo. Fully offline once the OCR models are warm-cached. Mirrors voice.ts.
 *
 * The recognizer auto-pairs the CRAFT text detector at load (no separate detector model
 * is wired) and the modelConfig/options are exactly what spike/06-ocr proved GO on this
 * Mac (and what the SDK's bundled examples/ocr-fasttext.js uses).
 */
import { loadModel, unloadModel, ocr } from "@qvac/sdk";
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";
import { OCR_LATIN_RECOGNIZER_1 } from "./models.ts";

/** Load the OCR model; returns its modelId. */
export async function loadOcr(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({
    modelSrc: OCR_LATIN_RECOGNIZER_1,
    modelType: "ocr",
    modelConfig: { langList: ["en"], useGPU: true, magRatio: 1.5, defaultRotationAngles: [90, 180, 270], contrastRetry: false, lowConfidenceThreshold: 0.5, recognizerBatchSize: 1 },
    onProgress: () => {},
  } as Parameters<typeof loadModel>[0]);
  audit?.record({ event: "model_load", modelSrc: OCR_LATIN_RECOGNIZER_1, modelId });
  return modelId;
}

/** Unload the OCR model. */
export async function unloadOcr(modelId: string, audit?: AuditLog): Promise<void> {
  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelSrc: OCR_LATIN_RECOGNIZER_1, modelId });
}

export interface OcrFileParams {
  ocrModelId: string;
  /** Path to an image file (e.g. a .png/.jpg). */
  imagePath: string;
  audit?: AuditLog;
}

/** OCR an image file to joined block text. Records a `note` with timing + char count. */
export async function ocrFile({ ocrModelId, imagePath, audit }: OcrFileParams): Promise<string> {
  const t = now();
  const { blocks } = ocr({ modelId: ocrModelId, image: imagePath, options: { paragraph: false } } as Parameters<typeof ocr>[0]);
  const text = (await blocks).map((b: { text: string }) => b.text).join(" ").replace(/\s+/g, " ").trim();
  audit?.record({ event: "note", durationMs: now() - t, extra: { role: "ocr", imagePath, chars: text.length } });
  return text;
}
