/**
 * Stage-0 gate: prove the AI SDK runs end-to-end on-device under JSC.
 *
 * Call `runBridgeSpike(modelId)` from a dev button (or the chat screen's debug menu) on a real
 * device. It exercises the WHOLE chain in isolation from the app: qvac-bridge fetch → on-device
 * `completion()` → OpenAI SSE → `@ai-sdk/openai-compatible` → `extractReasoningMiddleware` →
 * `streamText` multi-step loop with ONE trivial tool. It returns a transcript of the typed parts
 * (reasoning / text / tool-call / tool-result) so we can confirm — with no UI in the way — that
 * reasoning is split out (not leaked) and a tool round-trips. If this fails on JSC after the
 * polyfills, that's the signal to fall back to a native QVAC-SDK loop (the UI layer is identical).
 */
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { deviceChatModel } from "../qvac-bridge";
import { BRIDGE_SPIKE_NOW_TOOL_DESCRIPTION, BRIDGE_SPIKE_SYSTEM, BRIDGE_SPIKE_USER_PROMPT } from "../../prompt";

export type SpikeResult = {
  ok: boolean;
  reasoning: string;
  text: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  error?: string;
  log: string[];
};

export async function runBridgeSpike(modelId: string): Promise<SpikeResult> {
  const log: string[] = [];
  const toolCalls: SpikeResult["toolCalls"] = [];
  let reasoning = "";
  let text = "";
  try {
    log.push(`[spike] model=${modelId} starting streamText`);
    const result = streamText({
      model: deviceChatModel(modelId),
      system: BRIDGE_SPIKE_SYSTEM,
      messages: [{ role: "user", content: BRIDGE_SPIKE_USER_PROMPT }],
      tools: {
        now: tool({
          description: BRIDGE_SPIKE_NOW_TOOL_DESCRIPTION,
          inputSchema: z.object({}),
          execute: async () => ({ iso: new Date().toISOString() }),
        }),
      },
      stopWhen: stepCountIs(5),
    });

    // `fullStream` surfaces every typed part — the cleanest way to assert the gate without a UI.
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta":
          reasoning += part.text;
          break;
        case "text-delta":
          text += part.text;
          break;
        case "tool-call":
          log.push(`[spike] tool-call ${part.toolName} ${JSON.stringify(part.input)}`);
          toolCalls.push({ name: part.toolName, input: part.input, output: undefined });
          break;
        case "tool-result": {
          const tc = toolCalls.find((t) => t.name === part.toolName && t.output === undefined);
          if (tc) tc.output = part.output;
          log.push(`[spike] tool-result ${part.toolName} ${JSON.stringify(part.output)}`);
          break;
        }
        case "error":
          throw part.error;
      }
    }

    log.push(`[spike] DONE reasoning=${reasoning.length}c text=${text.length}c tools=${toolCalls.length}`);
    const ok = text.length > 0 && toolCalls.length > 0;
    return { ok, reasoning, text, toolCalls, log };
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    log.push(`[spike] FAILED ${error}`);
    return { ok: false, reasoning, text, toolCalls, error, log };
  }
}
