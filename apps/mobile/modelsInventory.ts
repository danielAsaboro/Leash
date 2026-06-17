/**
 * The phone's real model inventory — the standalone analogue of the desktop ModelsPanel. There is
 * no fabricated catalog: it is exactly the three @qvac/sdk models this app actually wires (chat,
 * speech-to-text, text-to-speech). Live state (loaded / cached / not-downloaded) and on-disk size
 * come straight from the SDK's getModelInfo, so a Models tab row reflects reality.
 */
import {
  downloadAsset,
  getModelInfo,
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  LLAMA_3_2_1B_INST_Q4_0,
  WHISPER_EN_SMALL_Q8_0,
  TTS_EN_SUPERTONIC_Q8_0,
  type ModelProgressUpdate,
} from "@qvac/sdk";

export type ModelKey = "chat" | "stt" | "tts";
export type ModelState = "loaded" | "cached" | "not-downloaded" | "unknown";

export type ModelEntry = {
  key: ModelKey;
  alias: string;
  label: string;
  role: string;
  kind: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assetSrc: any;
  name: string;
};

export const MODELS: ModelEntry[] = [
  { key: "chat", alias: "qwen3-1.7b", label: "Qwen3 · 1.7B", role: "Chat · the press", kind: "text", assetSrc: QWEN3_1_7B_INST_Q4, name: (QWEN3_1_7B_INST_Q4 as any).name },
  { key: "stt", alias: "whisper-small-en", label: "Whisper · small (EN)", role: "Voice → text", kind: "speech", assetSrc: WHISPER_EN_SMALL_Q8_0, name: (WHISPER_EN_SMALL_Q8_0 as any).name },
  { key: "tts", alias: "supertonic-en", label: "Supertonic · EN (F1)", role: "Text → voice", kind: "speech", assetSrc: TTS_EN_SUPERTONIC_Q8_0, name: (TTS_EN_SUPERTONIC_Q8_0 as any).name },
];

export type ModelStatus = ModelEntry & { state: ModelState; sizeBytes: number | null };

/** Probe one model's live state via the SDK. Falls back to "unknown" if the registry can't answer. */
export async function probeModel(entry: ModelEntry): Promise<ModelStatus> {
  try {
    const info: any = await getModelInfo({ name: entry.name } as any);
    const state: ModelState = info?.isLoaded ? "loaded" : info?.isCached ? "cached" : "not-downloaded";
    const sizeBytes: number | null = info?.actualSize ?? info?.expectedSize ?? null;
    return { ...entry, state, sizeBytes };
  } catch {
    return { ...entry, state: "unknown", sizeBytes: null };
  }
}

export async function listModels(): Promise<ModelStatus[]> {
  return Promise.all(MODELS.map(probeModel));
}

/** (Re)download a model's weights. Resolves instantly if already cached. */
export async function redownload(entry: ModelEntry, onProgress?: (pct: number) => void): Promise<void> {
  await downloadAsset({
    assetSrc: entry.assetSrc,
    onProgress: (p: ModelProgressUpdate) => onProgress?.(Math.round(p.percentage)),
  });
}

/** Sum of cached weights on disk (bytes) — best-effort, only counts models the SDK reports cached. */
export function totalDiskBytes(list: ModelStatus[]): number {
  return list.reduce((sum, m) => sum + (m.state === "cached" || m.state === "loaded" ? m.sizeBytes ?? 0 : 0), 0);
}

export function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function stateLabel(s: ModelState): string {
  return s === "loaded" ? "LOADED" : s === "cached" ? "READY" : s === "not-downloaded" ? "NOT DOWNLOADED" : "—";
}

/** A selectable on-device chat model (the user picks one; only one is loaded at a time). */
export type ChatModelEntry = {
  /** Stable key persisted as the user's choice. */
  chatKey: string;
  alias: string;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assetSrc: any;
  name: string;
};

/** Curated phone-runnable chat models. Default (qwen3-1.7b) keeps today's behavior on a fresh install. */
export const CHAT_MODELS: ChatModelEntry[] = [
  { chatKey: "qwen3-0.6b", alias: "qwen3-0.6b", label: "Qwen3 · 0.6B", assetSrc: QWEN3_600M_INST_Q4, name: (QWEN3_600M_INST_Q4 as any).name },
  { chatKey: "qwen3-1.7b", alias: "qwen3-1.7b", label: "Qwen3 · 1.7B", assetSrc: QWEN3_1_7B_INST_Q4, name: (QWEN3_1_7B_INST_Q4 as any).name },
  { chatKey: "qwen3-4b", alias: "qwen3-4b", label: "Qwen3 · 4B", assetSrc: QWEN3_4B_INST_Q4_K_M, name: (QWEN3_4B_INST_Q4_K_M as any).name },
  { chatKey: "llama-1b", alias: "llama-3.2-1b", label: "Llama 3.2 · 1B", assetSrc: LLAMA_3_2_1B_INST_Q4_0, name: (LLAMA_3_2_1B_INST_Q4_0 as any).name },
];

export const DEFAULT_CHAT_KEY = "qwen3-1.7b";

/** Resolve a chat-model entry by key, falling back to the default (never undefined). */
export function chatEntry(key: string | null | undefined): ChatModelEntry {
  return CHAT_MODELS.find((m) => m.chatKey === key) ?? CHAT_MODELS.find((m) => m.chatKey === DEFAULT_CHAT_KEY)!;
}

export type ChatModelStatus = ChatModelEntry & { state: ModelState; sizeBytes: number | null };

/** Probe each chat model's live state (loaded/cached/not-downloaded), reusing the SDK getModelInfo path. */
export async function listChatModels(): Promise<ChatModelStatus[]> {
  return Promise.all(
    CHAT_MODELS.map(async (entry): Promise<ChatModelStatus> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info: any = await getModelInfo({ name: entry.name } as any);
        const state: ModelState = info?.isLoaded ? "loaded" : info?.isCached ? "cached" : "not-downloaded";
        return { ...entry, state, sizeBytes: info?.actualSize ?? info?.expectedSize ?? null };
      } catch {
        return { ...entry, state: "unknown", sizeBytes: null };
      }
    }),
  );
}
