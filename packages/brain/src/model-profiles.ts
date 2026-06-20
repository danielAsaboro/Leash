export type DeviceModelProfileId = "desktop" | "phone" | "edge";

export type BrainModelRoleName =
  | "chat"
  | "classifier"
  | "embed"
  | "vision"
  | "health"
  | "speech_to_text"
  | "text_to_speech"
  | "image";

export type BrainModelCapabilityName = Exclude<BrainModelRoleName, "image">;

export interface BrainModelRole {
  device: DeviceModelProfileId;
  role: BrainModelRoleName;
  alias: string;
  model?: string;
  src?: string;
  type?: string;
  downloadName?: string;
  projection?: string;
  config?: Record<string, unknown>;
  bytes: number;
  powers: string;
  localRequired: boolean;
  delegateWhen?: "unavailable-or-too-heavy";
}

export interface DeviceModelProfile {
  id: DeviceModelProfileId;
  label: string;
  description: string;
  roles: BrainModelRole[];
}

export interface BrainModelAsset {
  name: string;
  assetSrc: string;
  role: BrainModelRoleName;
  alias: string;
}

export type BrainCapabilityVariants = Record<DeviceModelProfileId, BrainModelRole>;

const MEDPSY_4B_Q4_K_M_IMAT_URL = "https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf";
const MEDPSY_1_7B_Q4_K_M_IMAT_URL = "https://huggingface.co/qvac/MedPsy-1.7B-GGUF/resolve/main/medpsy-1.7b-q4_k_m-imat.gguf";

export const BRAIN_MODEL_VARIANTS: Record<BrainModelCapabilityName, BrainCapabilityVariants> = {
  chat: {
    desktop: {
      device: "desktop",
      role: "chat",
      alias: "qwen3-4b",
      model: "QWEN3_4B_INST_Q4_K_M",
      config: { tools: true, toolsMode: "dynamic", ctx_size: 32768 },
      bytes: 2_497_280_256,
      powers: "Full chat, tools, agents, and multi-step reasoning.",
      localRequired: true,
    },
    phone: {
      device: "phone",
      role: "chat",
      alias: "qwen3-1.7b",
      model: "QWEN3_1_7B_INST_Q4",
      config: { ctx_size: 8192 },
      bytes: 1_100_000_000,
      powers: "Default local phone chat.",
      localRequired: true,
    },
    edge: {
      device: "edge",
      role: "chat",
      alias: "qwen3-600m",
      model: "QWEN3_600M_INST_Q4",
      config: { ctx_size: 4096 },
      bytes: 382_156_480,
      powers: "Tiny local fallback chat and task classification.",
      localRequired: true,
    },
  },
  classifier: {
    desktop: {
      device: "desktop",
      role: "classifier",
      alias: "classifier",
      model: "QWEN3_600M_INST_Q4",
      config: { ctx_size: 8192 },
      bytes: 382_156_480,
      powers: "Fast routing, proactive heartbeat triage, and cheap intent checks.",
      localRequired: true,
    },
    phone: {
      device: "phone",
      role: "classifier",
      alias: "classifier",
      model: "QWEN3_600M_INST_Q4",
      config: { ctx_size: 4096 },
      bytes: 382_156_480,
      powers: "Local routing and cheap intent checks.",
      localRequired: true,
    },
    edge: {
      device: "edge",
      role: "classifier",
      alias: "classifier",
      model: "QWEN3_600M_INST_Q4",
      config: { ctx_size: 4096 },
      bytes: 382_156_480,
      powers: "Heartbeat and routing triage.",
      localRequired: true,
    },
  },
  embed: {
    desktop: {
      device: "desktop",
      role: "embed",
      alias: "embed",
      model: "GTE_LARGE_FP16",
      bytes: 669_603_712,
      powers: "RAG, memory search, skill routing, and context deduplication.",
      localRequired: true,
    },
    phone: {
      device: "phone",
      role: "embed",
      alias: "embed",
      model: "GTE_LARGE_FP16",
      bytes: 669_603_712,
      powers: "Local retrieval when memory allows; otherwise delegated.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
    edge: {
      device: "edge",
      role: "embed",
      alias: "embed",
      model: "GTE_LARGE_FP16",
      bytes: 669_603_712,
      powers: "Local retrieval when memory allows; otherwise delegated.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
  },
  vision: {
    desktop: {
      device: "desktop",
      role: "vision",
      alias: "qwen3vl",
      model: "QWEN3VL_2B_MULTIMODAL_Q4_K",
      projection: "MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K",
      config: { ctx_size: 8192 },
      bytes: 1_107_409_952 + 445_053_216,
      powers: "Image and screen understanding with the required mmproj projection.",
      localRequired: true,
    },
    phone: {
      device: "phone",
      role: "vision",
      alias: "qwen3vl",
      model: "QWEN3VL_2B_MULTIMODAL_Q4_K",
      projection: "MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K",
      config: { ctx_size: 4096 },
      bytes: 1_107_409_952 + 445_053_216,
      powers: "Local image understanding when cached and memory allows.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
    edge: {
      device: "edge",
      role: "vision",
      alias: "qwen3vl",
      model: "QWEN3VL_2B_MULTIMODAL_Q4_K",
      projection: "MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K",
      config: { ctx_size: 4096 },
      bytes: 1_107_409_952 + 445_053_216,
      powers: "Delegated image understanding unless the edge node has the weights cached.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
  },
  health: {
    desktop: {
      device: "desktop",
      role: "health",
      alias: "health",
      src: MEDPSY_4B_Q4_K_M_IMAT_URL,
      type: "llamacpp-completion",
      downloadName: "medpsy-4b-q4_k_m-imat.gguf",
      config: { tools: true, toolsMode: "dynamic", ctx_size: 8192 },
      bytes: 2_720_000_000,
      powers: "QVAC MedPsy 4B private health specialist grounded in records.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
    phone: {
      device: "phone",
      role: "health",
      alias: "health",
      src: MEDPSY_1_7B_Q4_K_M_IMAT_URL,
      type: "llamacpp-completion",
      downloadName: "medpsy-1.7b-q4_k_m-imat.gguf",
      config: { ctx_size: 4096 },
      bytes: 1_280_000_000,
      powers: "QVAC MedPsy 1.7B health specialist when local; otherwise delegated to the private mesh.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
    edge: {
      device: "edge",
      role: "health",
      alias: "health",
      src: MEDPSY_1_7B_Q4_K_M_IMAT_URL,
      type: "llamacpp-completion",
      downloadName: "medpsy-1.7b-q4_k_m-imat.gguf",
      config: { ctx_size: 4096 },
      bytes: 1_280_000_000,
      powers: "QVAC MedPsy 1.7B health specialist for edge nodes that can cache it; otherwise delegated.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
  },
  speech_to_text: {
    desktop: {
      device: "desktop",
      role: "speech_to_text",
      alias: "parakeet",
      model: "PARAKEET_TDT_0_6B_V3_Q8_0",
      bytes: 1_200_000_000,
      powers: "On-device speech transcription.",
      localRequired: false,
    },
    phone: {
      device: "phone",
      role: "speech_to_text",
      alias: "whisper-en",
      model: "WHISPER_EN_SMALL_Q8_0",
      bytes: 500_000_000,
      powers: "Voice input on device.",
      localRequired: false,
    },
    edge: {
      device: "edge",
      role: "speech_to_text",
      alias: "whisper-en",
      model: "WHISPER_EN_SMALL_Q8_0",
      bytes: 500_000_000,
      powers: "Voice input when the edge node has audio attached.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
  },
  text_to_speech: {
    desktop: {
      device: "desktop",
      role: "text_to_speech",
      alias: "supertonic",
      model: "TTS_EN_SUPERTONIC_Q8_0",
      config: { ttsEngine: "supertonic", language: "en", voice: "F1", ttsSpeed: 1.05, ttsNumInferenceSteps: 5 },
      bytes: 900_000_000,
      powers: "On-device spoken replies.",
      localRequired: false,
    },
    phone: {
      device: "phone",
      role: "text_to_speech",
      alias: "supertonic-en",
      model: "TTS_EN_SUPERTONIC_Q8_0",
      bytes: 900_000_000,
      powers: "Spoken replies on device.",
      localRequired: false,
    },
    edge: {
      device: "edge",
      role: "text_to_speech",
      alias: "supertonic-en",
      model: "TTS_EN_SUPERTONIC_Q8_0",
      bytes: 900_000_000,
      powers: "Spoken replies when an edge node has audio attached.",
      localRequired: false,
      delegateWhen: "unavailable-or-too-heavy",
    },
  },
};

const CAPABILITY_ORDER: BrainModelCapabilityName[] = ["chat", "classifier", "embed", "vision", "health", "speech_to_text", "text_to_speech"];

function rolesForDevice(device: DeviceModelProfileId): BrainModelRole[] {
  return CAPABILITY_ORDER.map((capability) => BRAIN_MODEL_VARIANTS[capability][device]);
}

export const DEVICE_MODEL_PROFILES: DeviceModelProfile[] = [
  {
    id: "desktop",
    label: "Desktop / Hub",
    description: "Full Brain runtime for web, desktop, and plugged-in providers.",
    roles: rolesForDevice("desktop"),
  },
  {
    id: "phone",
    label: "Phone",
    description: "Local-first mobile Brain runtime; delegates only work the phone cannot run.",
    roles: rolesForDevice("phone"),
  },
  {
    id: "edge",
    label: "Edge Node",
    description: "Always-on edge Brain runtime for quiet sensing, routing, and delegated fallback.",
    roles: rolesForDevice("edge"),
  },
];

export function modelVariantsForCapability(role: BrainModelCapabilityName): BrainCapabilityVariants {
  return BRAIN_MODEL_VARIANTS[role];
}

export function modelProfileForDevice(id: DeviceModelProfileId): DeviceModelProfile {
  const profile = DEVICE_MODEL_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`unknown Brain model profile "${id}"`);
  return profile;
}

export function modelConstantsForProfile(id: DeviceModelProfileId): string[] {
  return modelProfileForDevice(id).roles.flatMap((r) => {
    const models = r.model ? [r.model] : [];
    return r.projection ? [...models, r.projection] : models;
  });
}

export function modelAssetsForProfile(id: DeviceModelProfileId): BrainModelAsset[] {
  return modelProfileForDevice(id).roles.flatMap((r) => {
    const assets: BrainModelAsset[] = [];
    if (r.model) assets.push({ name: r.model, assetSrc: r.model, role: r.role, alias: r.alias });
    if (r.projection) assets.push({ name: r.projection, assetSrc: r.projection, role: r.role, alias: r.alias });
    if (r.src && r.downloadName) assets.push({ name: r.downloadName, assetSrc: r.src, role: r.role, alias: r.alias });
    return assets;
  });
}

export function modelAssetForName(name: string, id: DeviceModelProfileId = "desktop"): BrainModelAsset | undefined {
  return modelAssetsForProfile(id).find((asset) => asset.name === name);
}
