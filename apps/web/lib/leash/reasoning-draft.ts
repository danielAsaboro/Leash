import "server-only";
import { generateText, tool } from "ai";
import { z } from "zod";
import { chatModelBackground } from "./provider.ts";
import { REASONING_DRAFT_PLANNER_PROMPT } from "./prompt.ts";
import { normalizeReasoningDraft, qvacReasoningProviderOptions } from "./reasoning-policy.ts";
import { LEASH_AGENT_TIMEOUT } from "./runtime-lifecycle.ts";

const wireDraftSchema = z.object({
  mode: z.enum(["draft", "deep"]),
  // The local model occasionally overfills JSON-schema maxItems/maxLength. Accept
  // a modest wire envelope, then deterministically enforce the tighter contract.
  steps: z.array(z.string().trim().min(1).max(240)).min(1).max(12),
  verification: z.string().trim().max(400).optional(),
});

const draftTool = tool({
  description: "Submit the bounded private reasoning plan. This is the only allowed action.",
  inputSchema: wireDraftSchema,
});

export interface ReasoningDraft {
  mode: "draft" | "deep";
  steps: string[];
  verification?: string;
  generatedTokens: number;
  durationMs: number;
}

/**
 * One small QVAC-backed planning call replaces an unbounded prose scratchpad with a
 * schema-bounded Chain-of-Draft. Nothing is persisted or sent off-device. A failure
 * throws so the chat route can safely fall back to full deep reasoning.
 */
export async function planReasoningDraft(task: string, abortSignal?: AbortSignal): Promise<ReasoningDraft> {
  const started = Date.now();
  const result = await generateText({
    model: chatModelBackground(),
    instructions: REASONING_DRAFT_PLANNER_PROMPT,
    prompt: task.slice(0, 6_000),
    tools: { submit_reasoning_draft: draftTool },
    toolChoice: { type: "tool", toolName: "submit_reasoning_draft" },
    maxOutputTokens: 220,
    temperature: 0.7,
    topP: 0.8,
    maxRetries: 0,
    abortSignal,
    timeout: LEASH_AGENT_TIMEOUT,
    reasoning: "none",
    providerOptions: qvacReasoningProviderOptions(false),
  });
  const call = result.toolCalls.find((item) => item.toolName === "submit_reasoning_draft");
  if (!call) throw new Error("reasoning draft planner produced no structured plan");
  const parsed = normalizeReasoningDraft(wireDraftSchema.parse(call.input));
  return {
    ...parsed,
    generatedTokens: result.totalUsage.totalTokens ?? result.usage.totalTokens ?? 0,
    durationMs: Date.now() - started,
  };
}
