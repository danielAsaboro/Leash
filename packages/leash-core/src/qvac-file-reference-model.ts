import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { resolveProviderReference } from "@ai-sdk/provider-utils";
import type { QvacFilesOptions } from "./qvac-files.ts";

async function resolvePrompt(prompt: LanguageModelV4Prompt, options: QvacFilesOptions, signal?: AbortSignal): Promise<LanguageModelV4Prompt> {
  const request = options.fetch ?? globalThis.fetch;
  return Promise.all(prompt.map(async (message) => {
    if (message.role === "system" || message.role === "tool") return message;
    const content = await Promise.all(message.content.map(async (part) => {
      if (part.type !== "file" || part.data.type !== "reference") return part;
      const id = resolveProviderReference({ reference: part.data.reference, provider: "qvac" });
      const response = await request(`${options.baseURL.replace(/\/+$/, "")}/files/${encodeURIComponent(id)}/content`, {
        headers: options.headers,
        ...(signal !== undefined && { signal }),
      });
      if (!response.ok) throw new Error(`QVAC file reference ${id} is unavailable (${response.status})`);
      return { ...part, data: { type: "data" as const, data: new Uint8Array(await response.arrayBuffer()) } };
    }));
    return { ...message, content } as typeof message;
  }));
}

export function withQvacFileReferences(model: LanguageModelV4, options: QvacFilesOptions): LanguageModelV4 {
  const prepare = async (call: LanguageModelV4CallOptions): Promise<LanguageModelV4CallOptions> => ({
    ...call,
    prompt: await resolvePrompt(call.prompt, options, call.abortSignal),
  });
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (call) => model.doGenerate(await prepare(call)),
    doStream: async (call) => model.doStream(await prepare(call)),
  };
}
