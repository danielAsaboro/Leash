/**
 * Forage (server-only) — hardware-aware model recommendations.
 *
 * The organism forages its environment for what fits: given the SDK catalog + this
 * Mac's unified memory + what's already downloaded/configured, rank the models worth
 * running, grouped by use-case. Adapted from Odysseus `services/hwfit` scoring, but
 * grounded in our real catalog `expectedSize` and measured tok/s.
 *
 * Score (0-100), transparent and per-use-case among models that FIT:
 *   quality  — bigger params = more capable, with diminishing returns (log-ish)
 *   headroom — comfortable fit beats a tight squeeze (from estimateFit)
 *   speed    — measured tok/s when we have it, else a memory-bandwidth estimate
 *   ready    — small bump if already on disk (no download needed)
 * Already-configured models are shown as "in your config" but ranked below fresh
 * suggestions, since Forage is about what to ADD.
 */
import "server-only";
import { readCatalog, modelsInventory, measuredSpeeds, type CatalogModel } from "./models.ts";
import { estimateFit, deviceMemoryGB } from "./hwfit.ts";

/** Use-case buckets the recommender groups by (derived from addon + name). */
export type UseCase = "chat" | "vision" | "embedding" | "transcription" | "speech" | "image" | "other";

const USE_CASE_LABEL: Record<UseCase, string> = {
  chat: "Chat & reasoning",
  vision: "Vision (image understanding)",
  embedding: "Embeddings (search/RAG)",
  transcription: "Speech-to-text",
  speech: "Text-to-speech",
  image: "Image generation",
  other: "Other",
};

/** Apple-Silicon-ish unified memory bandwidth (GB/s) for the speed estimate. */
const BANDWIDTH_GBPS = Number(process.env["LEASH_MEM_BANDWIDTH_GBPS"] ?? 120);
const QUANT_BPP: Record<string, number> = { f32: 4, f16: 2, bf16: 2, fp8: 1, fp4: 0.5, int4: 0.5, int8: 1, q8_0: 1.05, q6_k: 0.8, q5_k_m: 0.68, q4_k_m: 0.58, q4_0: 0.58, q4: 0.58, q3_k_m: 0.48, q2_k: 0.37 };

function paramsB(p?: string): number {
  if (!p) return 0;
  const m = /([\d.]+)\s*([bm])/i.exec(p);
  return m ? parseFloat(m[1] as string) * ((m[2] as string).toLowerCase() === "m" ? 0.001 : 1) : 0;
}

function useCaseOf(m: CatalogModel): UseCase {
  const n = m.name.toLowerCase();
  // `endpointCategory` from the provider catalog is authoritative; only the chat bucket
  // needs a heuristic to split vision/multimodal out of "chat".
  const ec = (m.endpointCategory ?? "").toLowerCase();
  if (ec === "speech") return "speech";
  if (ec === "transcription") return "transcription";
  if (ec === "image") return "image";
  if (ec === "embedding") return "embedding";
  if (ec === "ocr" || ec === "translation") return "other";
  if (ec === "chat") return /vl|vision|multimodal|mmproj|llava/.test(n) ? "vision" : "chat";
  // Fallback (catalog without endpointCategory): the old addon/name heuristic.
  const a = (m.addon ?? "").toLowerCase();
  if (a === "tts" || /tts|speech|vocoder|supertonic|chatterbox/.test(n)) return "speech";
  if (a === "parakeet" || a === "whisper" || /whisper|parakeet|transcri|\bstt\b|asr/.test(n)) return "transcription";
  if (a === "diffusion" || /diffusion|flux|sdxl|stable-diffusion|\bsd\b/.test(n)) return "image";
  if (/embed|gte|bge|\bemb\b/.test(n)) return "embedding";
  if (/vl|vision|multimodal|mmproj|llava/.test(n)) return "vision";
  if (a === "llm" || a === "llamacpp-completion") return "chat";
  return "other";
}

/** Theoretical decode speed (tok/s) from memory bandwidth ÷ bytes-read-per-token. */
function estimateTokPerSec(m: CatalogModel): number | null {
  const pb = paramsB(m.params);
  if (pb <= 0) return null;
  const bpp = QUANT_BPP[(m.quantization ?? "").toLowerCase()] ?? 0.58;
  const bytesPerTok = pb * 1e9 * bpp;
  return bytesPerTok > 0 ? (BANDWIDTH_GBPS * 1e9) / bytesPerTok : null;
}

export interface Recommendation {
  name: string;
  params: string | null;
  quantization: string | null;
  useCase: UseCase;
  gb: number;
  fit: "fits" | "tight";
  /** tok/s — measured (real chat turns) or estimated (bandwidth). */
  tokPerSec: number | null;
  speedSource: "measured" | "estimated" | null;
  downloaded: boolean;
  inConfig: boolean;
  /** Configured alias if any (so the UI can say "running as …"). */
  alias: string | null;
  score: number;
  /** One-line human reason. */
  why: string;
}

export interface ForageResult {
  deviceGB: number;
  groups: { useCase: UseCase; label: string; recommendations: Recommendation[] }[];
}

/** Rank the catalog for this device, grouped by use-case (top N per group). */
export async function forage(perGroup = 5): Promise<ForageResult> {
  const [catalog, inventory, speeds] = await Promise.all([readCatalog(), modelsInventory(), measuredSpeeds()]);
  const deviceGB = deviceMemoryGB();

  // What's on disk (by cache filename) and what's configured (by SDK constant name).
  const onDisk = new Set([...inventory.configured, ...inventory.onDiskOnly].filter((r) => r.onDiskBytes !== null).map((r) => r.cacheFile));
  const configuredByName = new Map(inventory.configured.filter((r) => r.name).map((r) => [r.name, r.alias] as const));

  const scored: Recommendation[] = [];
  for (const m of catalog) {
    // Skip the SHARD/TENSORS bookkeeping entries and anything with no real size.
    if (/_SHARD$|_TENSORS$/.test(m.name) || !m.expectedSize || m.expectedSize < 1e6) continue;
    const fit = estimateFit({ expectedSize: m.expectedSize, params: m.params, quantization: m.quantization });
    if (fit.verdict === "too-big" || fit.verdict === null) continue; // only what can run

    const pb = paramsB(m.params);
    const measured = speeds.get(configuredByName.get(m.name) ?? "") ?? null;
    const estTps = estimateTokPerSec(m);
    const tokPerSec = measured ?? estTps;
    const speedSource = measured != null ? ("measured" as const) : estTps != null ? ("estimated" as const) : null;

    // Sub-scores (0-1).
    const quality = pb > 0 ? Math.min(1, Math.log10(1 + pb) / Math.log10(1 + 70)) : 0.3; // 70B ≈ 1.0
    const headroom = fit.verdict === "fits" ? 1 : 0.6;
    const speedNorm = tokPerSec != null ? Math.min(1, tokPerSec / 40) : 0.5; // ≥40 tok/s ≈ snappy
    const downloaded = m.cacheFile ? onDisk.has(m.cacheFile) : false;
    const inConfig = configuredByName.has(m.name);
    const score = Math.round((quality * 0.45 + headroom * 0.2 + speedNorm * 0.25 + (downloaded ? 0.1 : 0)) * 100);

    const why = [
      fit.verdict === "fits" ? "fits comfortably" : "fits (tight)",
      pb >= 1 ? `${m.params} params` : null,
      tokPerSec != null ? `~${tokPerSec.toFixed(tokPerSec < 10 ? 1 : 0)} tok/s${speedSource === "estimated" ? " est." : ""}` : null,
      downloaded ? "already downloaded" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    scored.push({
      name: m.name,
      params: m.params ?? null,
      quantization: m.quantization ?? null,
      useCase: useCaseOf(m),
      gb: fit.gb,
      fit: fit.verdict,
      tokPerSec,
      speedSource,
      downloaded,
      inConfig,
      alias: configuredByName.get(m.name) ?? null,
      score,
      why,
    });
  }

  const order: UseCase[] = ["chat", "vision", "embedding", "transcription", "speech", "image", "other"];
  const groups = order
    .map((useCase) => {
      const recs = scored
        .filter((r) => r.useCase === useCase)
        // Fresh suggestions first (not already in config), then by score.
        .sort((a, b) => Number(a.inConfig) - Number(b.inConfig) || b.score - a.score)
        .slice(0, perGroup);
      return { useCase, label: USE_CASE_LABEL[useCase], recommendations: recs };
    })
    .filter((g) => g.recommendations.length > 0);

  return { deviceGB, groups };
}
