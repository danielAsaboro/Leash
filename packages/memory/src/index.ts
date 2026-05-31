/**
 * Layer 4 — Memory: the evolution loop (Pillar 1). STUB: interfaces only.
 *
 * Interactions + user corrections/ratings + accepted council answers → a curated
 * training set on the Mac → nightly LoRA via QVAC Fabric → a personal adapter
 * distributed P2P to every device. A fixed eval harness charts "better at you"
 * over the event window. LoRA is primitive (d) in the spike (spec §Memory).
 */

/** One curated training example distilled from an accepted interaction. */
export interface TrainingExample {
  /** HF chat format: messages with roles; assistant turn is the learning target. */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Why this was accepted into the set (rating, correction, council-accepted). */
  provenance: "rating" | "correction" | "council";
}

/** A produced LoRA adapter ready to load via loadModel modelConfig.lora. */
export interface Adapter {
  /** Absolute path to the .gguf adapter written to outputParametersDir. */
  path: string;
  baseModelSrc: string;
  createdAt: string; // ISO
  trainExamples: number;
}

/** The nightly evolution loop (spec §Memory). */
export interface EvolutionLoop {
  /** Accumulate accepted interactions into the training set. */
  record(example: TrainingExample): Promise<void>;
  /** Run the nightly on-device LoRA over the accumulated set. */
  train(baseModelSrc: string): Promise<Adapter>;
  /** Fixed eval harness: preference adherence, personal-fact recall, style match. */
  evaluate(adapter: Adapter): Promise<{ score: number; detail: Record<string, number> }>;
}

export const LAYER = "memory" as const;
