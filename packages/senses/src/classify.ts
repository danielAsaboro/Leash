/**
 * Image classification connector (Layer 2 — Senses).
 *
 * On-device, millisecond image classification via `@qvac/sdk` `classify()` + the bundled
 * GGML MobileNetV3-Small (`modelType: "ggml-classification"`). The model ships inside
 * `@qvac/classification-ggml` — no `modelSrc`, no download, works offline immediately.
 *
 * The bundled model emits three coarse classes — **food / report / other** — which is a
 * cheap signal, not a fine-grained tagger. Its most useful job here is a **pre-filter for
 * OCR**: a "report" verdict means the photo is document-like (text worth extracting), so a
 * connector can tag the node and/or skip OCR on clearly non-document images.
 */
import { readFileSync } from "node:fs";
import { loadModel, unloadModel, classify } from "@qvac/sdk";
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";

/** Load the bundled GGML classifier; returns its modelId. No download (ships in-package). */
export async function loadClassifier(audit?: AuditLog): Promise<string> {
  const modelId = await loadModel({ modelType: "ggml-classification", onProgress: () => {} } as Parameters<typeof loadModel>[0]);
  audit?.record({ event: "model_load", modelSrc: "ggml-classification", modelId });
  return modelId;
}

/** Unload the classifier. */
export async function unloadClassifier(modelId: string, audit?: AuditLog): Promise<void> {
  await unloadModel({ modelId });
  audit?.record({ event: "model_unload", modelSrc: "ggml-classification", modelId });
}

/** One {label, confidence} verdict. */
export interface ClassLabel {
  label: string;
  confidence: number;
}

export interface ClassifyImageParams {
  classifierModelId: string;
  /** Path to an image file (png/jpg). */
  imagePath: string;
  audit?: AuditLog;
}

export interface ClassifyImageResult {
  /** Highest-confidence label. */
  top: ClassLabel;
  /** All labels, sorted by confidence desc. */
  all: ClassLabel[];
  /** True when the top label is "report" (document-like → OCR is worthwhile). */
  isDocument: boolean;
}

/** Classify an image. Records a `note` with the timing + top label. */
export async function classifyImage({ classifierModelId, imagePath, audit }: ClassifyImageParams): Promise<ClassifyImageResult> {
  const image = readFileSync(imagePath);
  const t = now();
  const raw = (await classify({ modelId: classifierModelId, image } as Parameters<typeof classify>[0])) as ClassLabel[];
  const all = raw.slice().sort((a, b) => b.confidence - a.confidence);
  const top = all[0] ?? { label: "other", confidence: 0 };
  audit?.record({ event: "note", durationMs: now() - t, extra: { role: "classify", imagePath, top: top.label, confidence: top.confidence } });
  return { top, all, isDocument: top.label === "report" };
}
