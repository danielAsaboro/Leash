import type { ProviderOptions } from "@ai-sdk/provider";

export type ReasoningMode = "direct" | "draft" | "deep";

export interface ReasoningPolicy {
  mode: ReasoningMode;
  /** Soft scratchpad allowance used by the prompt/draft planner. */
  thinkingBudgetTokens: number;
  /** Hard ceiling for the complete model call (reasoning + answer). */
  maxOutputTokens: number;
}

export interface NormalizedReasoningDraft {
  mode: "draft" | "deep";
  steps: string[];
  verification?: string;
}

export const DRAFT_OUTPUT_TOKENS = 700;
export const DEEP_OUTPUT_TOKENS = 1_800;
export const DEEP_THINKING_TOKENS = 700;

export function policyForPlannedMode(mode: "draft" | "deep", configuredOutputTokens: number): ReasoningPolicy {
  if (mode === "draft") {
    return {
      mode,
      thinkingBudgetTokens: 0,
      maxOutputTokens: Math.min(configuredOutputTokens, DRAFT_OUTPUT_TOKENS),
    };
  }
  return {
    mode,
    thinkingBudgetTokens: DEEP_THINKING_TOKENS,
    maxOutputTokens: Math.min(configuredOutputTokens, DEEP_OUTPUT_TOKENS),
  };
}

const firstWords = (text: string, count: number): string => text.trim().split(/\s+/).slice(0, count).join(" ");

/** Enforce the actual Chain-of-Draft contract even when a small model overfills tool arguments. */
export function normalizeReasoningDraft(input: {
  mode: "draft" | "deep";
  steps: string[];
  verification?: string;
}): NormalizedReasoningDraft {
  const steps = input.steps
    .map((step) => firstWords(step, 5).slice(0, 48))
    .filter(Boolean)
    .slice(0, 6);
  if (steps.length === 0) throw new Error("reasoning draft contained no usable steps");
  const verification = input.verification ? firstWords(input.verification, 12).slice(0, 80) : "";
  return { mode: input.mode, steps, ...(verification ? { verification } : {}) };
}

/**
 * QVAC exposes reasoning as a per-request on/off switch. Always send it explicitly:
 * `/no_think` remains useful model guidance, but this provider option is the actual
 * inference control and prevents a nominally quick turn from silently burning a
 * hidden `<think>` trace.
 */
export function qvacReasoningProviderOptions(enabled: boolean): ProviderOptions {
  return { qvac: { reasoning_budget: enabled } };
}
