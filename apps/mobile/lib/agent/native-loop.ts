/**
 * The native on-device agent loop — the JSC-safe replacement for the Vercel AI SDK runtime.
 *
 * The AI SDK's `streamText`/`createOpenAICompatible` path (custom fetch → synthesized `Response` with
 * a `ReadableStream` body → `TextDecoderStream` SSE parsing) does NOT run under React Native's JSC
 * engine — it fails before ever calling the model (confirmed on-device: a send produced no inference
 * activity at all). So we drive `@qvac/sdk` `completion()` directly — the same call the app shipped on
 * — and assemble the SAME parts model the UI renders (reasoning / text / tool cards), including the
 * multi-step tool loop. No AI SDK code executes at runtime; the `ai`-typed UI components only consume
 * the plain parts array we build here.
 *
 * Reasoning is free: `completion().events` emits `thinkingDelta` (the model's `<think>`) separately
 * from `contentDelta`, so we route them to a reasoning part and a text part respectively — which is
 * what finally kills the old `stripThink()` leak, on a code path that actually runs.
 */
import { completion, type ToolCallWithCall } from "@qvac/sdk";
import type { ToolSet } from "ai";

/** A rendered part — structurally what `MessageParts` expects (AI-SDK-compatible shapes, hand-built). */
export type Part =
  | { type: "reasoning"; text: string; state: "streaming" | "done" }
  | { type: "text"; text: string; state: "streaming" | "done" }
  | { type: "data-skill"; data: unknown }
  | { type: "data-agent"; data: unknown }
  | {
      type: `tool-${string}`;
      toolName: string;
      toolCallId: string;
      state: "input-available" | "output-available" | "output-error";
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };

type Msg = { role: string; content: string };

/**
 * Split a (possibly mid-stream) assistant string into its leading `<think>…</think>` reasoning and
 * the visible answer. Handles an unclosed `<think>` while the borrow stream is still thinking. Used
 * by the mesh-borrow path, where the peer streams one combined text blob (no separate event types).
 */
export function splitThink(full: string): { reasoning: string; text: string } {
  const open = full.indexOf("<think>");
  if (open === -1) return { reasoning: "", text: full };
  let text = full.slice(0, open);
  const rest = full.slice(open + "<think>".length);
  const close = rest.indexOf("</think>");
  if (close === -1) return { reasoning: rest, text };
  return { reasoning: rest.slice(0, close), text: text + rest.slice(close + "</think>".length) };
}

/** Build a reasoning+text parts array (with optional leading cards) from split strings. */
export function partsFromText(reasoning: string, text: string, lead: Part[] = [], streaming = false): Part[] {
  const parts: Part[] = [...lead];
  if (reasoning.trim()) parts.push({ type: "reasoning", text: reasoning, state: streaming && !text ? "streaming" : "done" });
  if (text) parts.push({ type: "text", text, state: streaming ? "streaming" : "done" });
  return parts;
}

/** Convert an SDK tool registry's parameters back to the flat `@qvac/sdk` tool schema. */
function toSdkTools(tools: ToolSet): unknown[] | undefined {
  const names = Object.keys(tools);
  if (names.length === 0) return undefined;
  const out: unknown[] = [];
  for (const name of names) {
    const t = tools[name] as { description?: string; inputSchema?: unknown };
    // The AI SDK `tool()` keeps a zod schema on `inputSchema`; @qvac/sdk wants a flat JSON-schema-ish
    // object. zod v4 exposes `.shape` for objects — map each key to a primitive type. Best-effort:
    // unknown shapes fall back to an empty object (the model can still call with no args).
    const shape = (t.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
    const properties: Record<string, { type: string; description?: string }> = {};
    for (const key of Object.keys(shape)) properties[key] = { type: "string" };
    out.push({ type: "function", name, description: t.description ?? "", parameters: { type: "object", properties } });
  }
  return out;
}

async function execTool(tools: ToolSet, name: string, args: unknown): Promise<unknown> {
  const t = tools[name] as { execute?: (input: unknown, opts: unknown) => Promise<unknown> } | undefined;
  if (!t?.execute) throw new Error(`unknown tool: ${name}`);
  return t.execute(args, { toolCallId: `${name}-${Date.now()}`, messages: [] });
}

export type NativeTurnOpts = {
  modelId: string;
  system: string;
  history: Msg[]; // user/assistant turns (no system)
  tools?: ToolSet;
  maxSteps?: number;
  leadingParts?: Part[]; // e.g. a data-skill card prepended to the render
  onUpdate: (parts: Part[]) => void;
  isCancelled: () => boolean;
};

/**
 * Run one turn locally. Streams reasoning + text; if the model emits tool calls, executes them
 * on-device and loops with the results appended (up to `maxSteps`). Returns the final answer text.
 */
export async function runNativeTurn(opts: NativeTurnOpts): Promise<string> {
  const tools = opts.tools ?? {};
  const sdkTools = toSdkTools(tools);
  const maxSteps = opts.maxSteps ?? 6;
  const lead = opts.leadingParts ?? [];

  const convo: Msg[] = [{ role: "system", content: opts.system }, ...opts.history];
  const parts: Part[] = [...lead];
  let finalText = "";

  for (let step = 0; step < maxSteps; step++) {
    if (opts.isCancelled()) break;

    const run = completion({ modelId: opts.modelId, history: convo, stream: true, ...(sdkTools ? { tools: sdkTools } : {}) } as Parameters<typeof completion>[0]);

    // Stream the PROVEN primitive: tokenStream yields raw tokens (incl. <think>). We accumulate and
    // split into reasoning + text on every tick — the exact approach the app shipped on, so plain
    // text always streams even if tool parsing varies. Fresh parts are spliced in after the lead.
    let raw = "";
    const stepStart = parts.length;
    for await (const token of run.tokenStream as AsyncGenerator<string>) {
      if (opts.isCancelled()) break;
      raw += token;
      const { reasoning, text } = splitThink(raw);
      parts.length = stepStart; // replace this step's reasoning/text parts each tick
      parts.push(...partsFromText(reasoning, text, [], true));
      opts.onUpdate([...parts]);
    }
    // Finalize this step's parts (state → done).
    {
      const { reasoning, text } = splitThink(raw);
      parts.length = stepStart;
      parts.push(...partsFromText(reasoning, text, [], false));
      finalText = text || finalText;
      opts.onUpdate([...parts]);
    }

    const final = await run.final.catch(() => null);
    const calls: ToolCallWithCall[] = final?.toolCalls ?? [];
    if (!finalText && final?.contentText) finalText = final.contentText;

    if (calls.length === 0 || opts.isCancelled()) {
      opts.onUpdate([...parts]);
      break;
    }

    // Record the assistant's tool calls in the running transcript, then execute each on-device.
    convo.push({ role: "assistant", content: calls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments })}</tool_call>`).join("\n") });
    for (const c of calls) {
      const toolPart: Part = { type: `tool-${c.name}`, toolName: c.name, toolCallId: c.id, state: "input-available", input: c.arguments };
      parts.push(toolPart);
      opts.onUpdate([...parts]);
      try {
        const output = await execTool(tools, c.name, c.arguments);
        toolPart.state = "output-available";
        toolPart.output = output;
        convo.push({ role: "tool", content: `<tool_response>${JSON.stringify({ name: c.name, output })}</tool_response>` });
      } catch (e) {
        toolPart.state = "output-error";
        toolPart.errorText = (e as Error)?.message ?? String(e);
        convo.push({ role: "tool", content: `<tool_response>${JSON.stringify({ name: c.name, error: toolPart.errorText })}</tool_response>` });
      }
      opts.onUpdate([...parts]);
    }
    // Loop: re-call the model with the tool results in context.
  }

  return finalText;
}
