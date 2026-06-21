/**
 * Live, on-device QVAC A/B: unrestricted reasoning versus bounded Chain-of-Draft.
 * Prints aggregate JSON only; hidden reasoning text is never persisted or displayed.
 */
import { createQvac } from "@mycelium/leash-core/qvac-provider";
import { generateText, tool } from "ai";
import { z } from "zod";
import { REASONING_DRAFT_PLANNER_PROMPT, buildReasoningDraftSection } from "../apps/web/lib/leash/prompt.ts";
import { normalizeReasoningDraft, qvacReasoningProviderOptions } from "../apps/web/lib/leash/reasoning-policy.ts";

const baseURL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const alias = process.env["LEASH_CHAT_MODEL"] ?? "chat";
const qvac = createQvac({ baseURL, apiKey: "qvac" });
const model = qvac(alias);
const task = process.argv.slice(2).join(" ").trim() ||
  "Plan the ordered steps to migrate a local SQLite application to encrypted-at-rest storage while preserving offline startup, rollback safety, and crash consistency. Give the dependency order and decisive verification gates.";

const draftSchema = z.object({
  mode: z.enum(["draft", "deep"]),
  steps: z.array(z.string().min(1).max(240)).min(1).max(12),
  verification: z.string().max(400).optional(),
});
const answerSchema = z.object({
  answer: z.string().min(12).max(8_000),
  gates: z.array(z.string().min(2).max(240)).max(10),
});
const submitDraft = tool({ description: "Submit the private bounded draft.", inputSchema: draftSchema });
const submitAnswer = tool({ description: "Submit the final answer and decisive verification gates.", inputSchema: answerSchema });

interface BenchResult {
  generatedTokens: number;
  durationMs: number;
  completed: boolean;
  qualityChecks: Record<string, boolean>;
}

function quality(answer: string, gates: string[]): Record<string, boolean> {
  const text = `${answer} ${gates.join(" ")}`.toLowerCase();
  return {
    encryption: /encrypt|sqlcipher/.test(text),
    offline: /offline|local key|keychain|keystore/.test(text),
    rollback: /rollback|backup|side-by-side|atomic/.test(text),
    crashConsistency: /crash|wal|journal|consisten/.test(text),
    verificationGates: gates.length >= 3,
  };
}

async function finalCall(system: string, reasoning: boolean, maxOutputTokens: number): Promise<BenchResult> {
  const started = Date.now();
  const result = await generateText({
    model,
    instructions: system,
    prompt: task,
    tools: { submit_answer: submitAnswer },
    toolChoice: { type: "tool", toolName: "submit_answer" },
    maxOutputTokens,
    temperature: reasoning ? 0.6 : 0.7,
    topP: reasoning ? 0.95 : 0.8,
    maxRetries: 0,
    providerOptions: qvacReasoningProviderOptions(reasoning),
  });
  const call = result.toolCalls.find((item) => item.toolName === "submit_answer");
  const parsed = call ? answerSchema.safeParse(call.input) : null;
  const answer = parsed?.success ? parsed.data.answer : "";
  const gates = parsed?.success ? parsed.data.gates : [];
  return {
    generatedTokens: result.totalUsage.totalTokens ?? result.usage.totalTokens ?? 0,
    durationMs: Date.now() - started,
    completed: !!parsed?.success,
    qualityChecks: quality(answer, gates),
  };
}

const baseline = await finalCall(
  "Reason carefully and thoroughly. Explore dependencies and verify the result before submitting the final answer.",
  true,
  1_200,
);

const draftStarted = Date.now();
const draftResult = await generateText({
  model,
  instructions: REASONING_DRAFT_PLANNER_PROMPT,
  prompt: task,
  tools: { submit_reasoning_draft: submitDraft },
  toolChoice: { type: "tool", toolName: "submit_reasoning_draft" },
  maxOutputTokens: 220,
  temperature: 0.7,
  topP: 0.8,
  maxRetries: 0,
  providerOptions: qvacReasoningProviderOptions(false),
});
const draftCall = draftResult.toolCalls.find((item) => item.toolName === "submit_reasoning_draft");
if (!draftCall) throw new Error("optimized draft call did not return a structured plan");
const draft = normalizeReasoningDraft(draftSchema.parse(draftCall.input));
const draftMs = Date.now() - draftStarted;
const optimizedFinal = await finalCall(buildReasoningDraftSection(draft), draft.mode === "deep", draft.mode === "deep" ? 1_800 : 700);
const draftTokens = draftResult.totalUsage.totalTokens ?? draftResult.usage.totalTokens ?? 0;
const optimized = {
  ...optimizedFinal,
  draftMode: draft.mode,
  draftTokens,
  draftMs,
  generatedTokens: draftTokens + optimizedFinal.generatedTokens,
  durationMs: draftMs + optimizedFinal.durationMs,
};

const percent = (before: number, after: number): number => before > 0 ? Math.round((1 - after / before) * 1_000) / 10 : 0;
console.log(JSON.stringify({
  task,
  baseline,
  optimized,
  change: {
    generatedTokensPercent: percent(baseline.generatedTokens, optimized.generatedTokens),
    durationPercent: percent(baseline.durationMs, optimized.durationMs),
  },
}, null, 2));
