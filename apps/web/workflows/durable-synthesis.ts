import { createQvac } from "@mycelium/leash-core/qvac-provider";
import { extractReasoningMiddleware, generateText, wrapLanguageModel } from "ai";

export interface DurableSynthesisInput {
  prompt: string;
  maxOutputTokens?: number;
  /** Trusted, server-populated local inference endpoint. Never accepted from the public request body. */
  baseURL: string;
  /** Trusted, server-populated local model alias. Never accepted from the public request body. */
  model: string;
}

export interface DurableSynthesisResult {
  text: string;
  steps: number;
  finishReason: string;
  totalTokens: number;
}

interface SynthesisStepInput {
  baseURL: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
}

interface SynthesisStepResult {
  text: string;
  finishReason: string;
  totalTokens: number;
}

async function runLocalSynthesisStep(input: SynthesisStepInput): Promise<SynthesisStepResult> {
  "use step";

  // Provider instances contain functions and therefore must be constructed
  // inside the durable step, after the workflow serialization boundary.
  const qvac = createQvac({
    baseURL: input.baseURL,
    apiKey: "qvac",
    headers: { "x-leash-priority": "background" },
  });
  const model = wrapLanguageModel({
    model: qvac(input.model),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
  const result = await generateText({
    model,
    prompt: input.prompt,
    maxRetries: 0,
    maxOutputTokens: input.maxOutputTokens,
    temperature: 0.7,
    topP: 0.8,
    providerOptions: { qvac: { reasoning_budget: false } },
    timeout: 180_000,
  });
  return {
    text: result.text.trim(),
    finishReason: result.finishReason,
    totalTokens: result.totalUsage.totalTokens ?? 0,
  };
}

/** Durable, local-only background synthesis with a resumable plan/finalize boundary. */
export async function durableSynthesis(input: DurableSynthesisInput): Promise<DurableSynthesisResult> {
  "use workflow";

  const prompt = input.prompt.slice(0, 20_000);
  const outline = await runLocalSynthesisStep({
    baseURL: input.baseURL,
    model: input.model,
    prompt:
      "Create a terse factual outline for the request below. Preserve uncertainty and do not invent evidence.\n\n" +
      prompt,
    maxOutputTokens: 240,
  });
  const final = await runLocalSynthesisStep({
    baseURL: input.baseURL,
    model: input.model,
    prompt:
      "Answer the original request concisely using the working outline. Correct any unsupported claim in the outline. " +
      "Return only the final answer.\n\nORIGINAL REQUEST:\n" +
      prompt +
      "\n\nWORKING OUTLINE:\n" +
      outline.text,
    maxOutputTokens: Math.min(1_200, Math.max(80, input.maxOutputTokens ?? 700)),
  });
  return {
    text: final.text,
    steps: 2,
    finishReason: final.finishReason,
    totalTokens: outline.totalTokens + final.totalTokens,
  };
}
