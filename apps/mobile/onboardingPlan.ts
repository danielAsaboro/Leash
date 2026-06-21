import { CHAT_MODELS, MODELS, chatEntry, fmtBytes } from "./modelsInventory";
import { KNOWN_SECRETS } from "./knownSecrets";

export type DownloadTiming = "during-setup" | "later-on-demand";

export type DownloadPlanRow = {
  key: string;
  label: string;
  purpose: string;
  sizeBytes: number | null;
  sizeLabel: string;
  timing: DownloadTiming;
};

export type DownloadPlan = {
  title: string;
  summary: string;
  defaultExpanded: boolean;
  rows: DownloadPlanRow[];
  totalBytes: number;
  totalSizeLabel: string;
};

export type ResetTarget = {
  key: string;
  label: string;
  suffix: string;
  kind: "file" | "dir";
};

export type FactoryResetPlan = {
  files: ResetTarget[];
  secureStoreKeys: string[];
};

const PURPOSE_BY_KEY: Record<string, string> = {
  chat: "Primary on-device chat model used for replies in the app.",
  ocr: "Optical character recognition for reading text from images.",
  stt: "Speech-to-text for voice input and transcription on this device.",
  tts: "Text-to-speech voice model for spoken playback on this device.",
};

const FACTORY_RESET_FILES: ResetTarget[] = [
  { key: "device-identity", label: "Device identity", suffix: "device-identity.json", kind: "file" },
  { key: "onboarding", label: "Onboarding state", suffix: "onboarding.json", kind: "file" },
  { key: "selected-model", label: "Selected chat model", suffix: "selectedModel.json", kind: "file" },
  { key: "chats", label: "Conversations", suffix: "chats", kind: "dir" },
  { key: "tasks", label: "Tasks", suffix: "tasks.json", kind: "file" },
  { key: "notes", label: "Notes", suffix: "notes", kind: "dir" },
  { key: "notifications", label: "Notifications", suffix: "notifications.json", kind: "file" },
  { key: "prompts", label: "Prompt overrides", suffix: "prompts.json", kind: "file" },
  { key: "memories", label: "Memories", suffix: "memories.json", kind: "file" },
  { key: "constitution", label: "Constitution", suffix: "constitution.json", kind: "file" },
  { key: "skills", label: "Mesh-published skills cache", suffix: "skills.json", kind: "file" },
  { key: "mesh-store", label: "Mesh identity and local replica", suffix: "mesh-store", kind: "dir" },
];

function expectedSize(assetSrc: unknown): number | null {
  const size = (assetSrc as { expectedSize?: unknown } | null)?.expectedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

export function buildFirstDeviceDownloadPlan(
  chatKey: string,
  options?: {
    deviceLabel?: string;
  },
): DownloadPlan {
  const chat = chatEntry(chatKey);
  const support = MODELS.filter((entry) => entry.key !== "chat");
  const rows: DownloadPlanRow[] = [
    {
      key: "chat",
      label: chat.label,
      purpose: PURPOSE_BY_KEY.chat,
      sizeBytes: expectedSize(chat.assetSrc),
      sizeLabel: fmtBytes(expectedSize(chat.assetSrc)),
      timing: "during-setup",
    },
    ...support.map((entry) => ({
      key: entry.key,
      label: entry.label,
      purpose: PURPOSE_BY_KEY[entry.key] ?? entry.role,
      sizeBytes: expectedSize(entry.assetSrc),
      sizeLabel: fmtBytes(expectedSize(entry.assetSrc)),
      timing: "during-setup" as const,
    })),
  ];

  const totalBytes = rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);

  return {
    title: `What ${options?.deviceLabel ?? "Leash"} will download`,
    summary: `${rows.length} assets will be cached on ${options?.deviceLabel ?? "this device"} before setup finishes.`,
    defaultExpanded: false,
    rows,
    totalBytes,
    totalSizeLabel: fmtBytes(totalBytes),
  };
}

export function buildFactoryResetPlan(): FactoryResetPlan {
  return {
    files: FACTORY_RESET_FILES,
    secureStoreKeys: KNOWN_SECRETS.map((secret) => secret.name),
  };
}

export function isSelectableFirstRunChatKey(chatKey: string): boolean {
  return CHAT_MODELS.some((entry) => entry.chatKey === chatKey);
}
