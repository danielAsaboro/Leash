/**
 * The Assistant Kit — the recommended on-device model fleet for the proactive assistant.
 *
 * Pure data, CLIENT-SAFE (no `fs`/SDK imports) so BOTH the server kit-writer (`models.ts`
 * `addModelKit`) and the dashboard "Assistant Kit" card (`ModelsPanel.tsx`) import the same
 * single source of truth. SKUs, sizes, and the vision mmproj companion are verified against the
 * live `@qvac/ai-sdk-provider` catalog dump (scripts/leash-model-catalog.mts).
 *
 * Two-tier fleet by design: a small fast `classifier` triages every heartbeat cheaply; the 4B
 * `chat` model only wakes when the heartbeat escalates. The `vision` role pairs the multimodal
 * weight with its mmproj projection — downloading a bare mmproj is the live bug this kit fixes,
 * so the kit ALWAYS ships the base weight + the projection together and wires `projectionModelSrc`.
 */
export type KitRoleName = "chat" | "classifier" | "embed" | "vision";

export interface KitRole {
  role: KitRoleName;
  /** The served alias written into qvac.config.base.json → serve.models. */
  alias: string;
  /** Primary SDK catalog constant (the main weight). */
  model: string;
  /** Companion projection weight (vision mmproj) — downloaded with the base and wired as projectionModelSrc. */
  projection?: string;
  /** serve config block for the alias (projectionModelSrc is filled in at write time from the catalog). */
  config?: Record<string, unknown>;
  /** Approx total download size in bytes (primary + projection), for the UI. */
  bytes: number;
  /** One-line "what this role powers", shown on the kit card. */
  powers: string;
}

export const ASSISTANT_KIT: KitRole[] = [
  {
    role: "chat",
    alias: "qwen3-4b",
    model: "QWEN3_4B_INST_Q4_K_M",
    config: { tools: true, toolsMode: "dynamic", ctx_size: 32768 },
    bytes: 2_497_280_256,
    powers: "Chat & reasoning — the model that acts when the heartbeat escalates.",
  },
  {
    role: "classifier",
    alias: "classifier",
    model: "QWEN3_600M_INST_Q4",
    config: { ctx_size: 8192 },
    bytes: 382_156_480,
    powers: "Fast triage — runs every heartbeat to decide silence vs. escalate, cheaply.",
  },
  {
    role: "embed",
    alias: "gte-large",
    model: "GTE_LARGE_FP16",
    bytes: 669_603_712,
    powers: "Embeddings — RAG retrieval, on-goal scoring, and notification dedup.",
  },
  {
    role: "vision",
    alias: "qwen3vl",
    model: "QWEN3VL_2B_MULTIMODAL_Q4_K",
    projection: "MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K",
    config: { ctx_size: 8192 },
    bytes: 1_107_409_952 + 445_053_216,
    powers: "Vision — screen understanding for leash-watch activity (base weight + mmproj).",
  },
];

/** Every SDK catalog constant the kit needs downloaded (primary weights + vision projection). */
export function kitModels(kit: KitRole[] = ASSISTANT_KIT): string[] {
  return kit.flatMap((r) => (r.projection ? [r.model, r.projection] : [r.model]));
}

/** Map an SDK catalog constant → the kit role it fills (primary OR projection), if any. */
export function kitRoleOf(modelName: string, kit: KitRole[] = ASSISTANT_KIT): KitRoleName | undefined {
  return kit.find((r) => r.model === modelName || r.projection === modelName)?.role;
}
