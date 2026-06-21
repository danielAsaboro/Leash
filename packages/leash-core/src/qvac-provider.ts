import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { FilesV4 } from "@ai-sdk/provider";
import { createQvacFiles } from "./qvac-files.ts";
import { withQvacFileReferences } from "./qvac-file-reference-model.ts";

export interface QvacProviderOptions {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export type QvacProvider = OpenAICompatibleProvider & { files(): FilesV4 };

/**
 * AI SDK 7 adapter for a QVAC SDK OpenAI-compatible serve.
 *
 * This is deliberately transport-only: model loading, inference, embeddings,
 * image generation, and every other model operation remain inside `@qvac/sdk`.
 */
export function createQvac(options: QvacProviderOptions = {}): QvacProvider {
  const baseURL = options.baseURL ?? "http://127.0.0.1:11435/v1";
  const apiKey = options.apiKey ?? "qvac";
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, ...(options.headers ?? {}) };
  const compatible = createOpenAICompatible({
    name: "qvac",
    baseURL,
    apiKey,
    headers: options.headers,
    fetch: options.fetch,
  });
  const localOptions = { baseURL, headers, ...(options.fetch !== undefined && { fetch: options.fetch }) };
  const wrap = (model: ReturnType<typeof compatible.chatModel>) => withQvacFileReferences(model, localOptions);
  const provider = ((modelId: string) => wrap(compatible(modelId))) as QvacProvider;
  Object.assign(provider, compatible);
  provider.languageModel = (modelId: string) => wrap(compatible.languageModel(modelId));
  provider.chatModel = (modelId: string) => wrap(compatible.chatModel(modelId));
  provider.files = () => createQvacFiles(localOptions);
  return provider;
}
