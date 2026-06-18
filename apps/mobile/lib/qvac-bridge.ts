/**
 * The on-device QVAC model, wired into the Vercel AI SDK — the React Native analogue of
 * `apps/web/lib/leash/provider.ts`, but with NO server and NO HTTP.
 *
 * The web app reaches inference over `qvac serve openai` (a real :11435 endpoint). The phone has
 * no such server, so this module is the seam that makes the AI SDK think it does: a custom `fetch`
 * passed to `@ai-sdk/openai-compatible` answers `POST /v1/chat/completions` *in-process* from the
 * on-device `completion()` token/tool stream. The provider never makes a network call — `qvacFetch`
 * intercepts the request, drives `@qvac/sdk`, and synthesises an OpenAI Server-Sent-Events stream
 * that the provider already knows how to parse. Inference therefore stays 100% on-device (the
 * hackathon "no cloud AI" rule holds) while we inherit the SDK's streaming, tool-calling, and
 * multi-step agent loop for free.
 *
 * Two facts make the fetch shim faithful (verified against the installed packages):
 *  - `createQvac` (web) only forwards `name/baseURL/apiKey/headers/fetch` into
 *    `createOpenAICompatible`, so using the compatible provider directly is equivalent and avoids
 *    the qvac provider's Node-coupled managed/registry code.
 *  - `@ai-sdk/openai-compatible` parses each SSE `data:` line as
 *    `{ choices:[{ delta:{ content?, reasoning_content?, tool_calls? }, finish_reason? }] }`,
 *    terminated by `data: [DONE]`. `@qvac/sdk`'s `CompletionRun.events` is an ordered async-iterable
 *    of `contentDelta | thinkingDelta | toolCall | toolError | completionStats`, which maps 1:1.
 *
 * Reasoning: `thinkingDelta` → `delta.reasoning_content` (the provider emits this as a native
 * reasoning part). We ALSO wrap the model in `extractReasoningMiddleware({ tagName:"think" })` as a
 * belt-and-suspenders for any model that inlines `<think>…</think>` in content instead — harmless
 * when content is already think-free.
 */
import { completion, type CompletionEvent } from "@qvac/sdk";
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { meshForward } from "../forwardWorklet";

/** A sentinel base URL — never actually dialed; `qvacFetch` short-circuits every request. */
const QVAC_BASE = "http://qvac.local/v1";

/** OpenAI chat message as the openai-compatible provider serialises it onto the wire. */
type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
};

/** OpenAI tool definition (nested under `function`) — flattened for `@qvac/sdk`. */
type OpenAITool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

/** The flat tool shape `@qvac/sdk`'s `completion({ tools })` expects. */
type QvacTool = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
};

/** Collapse an OpenAI content field (string OR an array of parts) down to plain text. */
function flattenContent(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
  return "";
}

/**
 * OpenAI messages → `@qvac/sdk` `history` ({ role, content } strings). The SDK history has no
 * structured tool-call/tool-result slots, so we render those into the text the model's chat
 * template understands: an assistant tool call becomes a `<tool_call>` block, a tool result becomes
 * a `<tool_response>` block carrying its `tool_call_id`. This is the Hermes/Qwen convention and is
 * the part most likely to need device-gate tuning per model dialect.
 */
function toQvacHistory(messages: OpenAIMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls
        .map((c) => `<tool_call>${JSON.stringify({ name: c.function?.name, arguments: safeParse(c.function?.arguments) })}</tool_call>`)
        .join("\n");
      const text = flattenContent(m.content);
      out.push({ role: "assistant", content: text ? `${text}\n${calls}` : calls });
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "tool", content: `<tool_response>${JSON.stringify({ tool_call_id: m.tool_call_id, content: flattenContent(m.content) })}</tool_response>` });
      continue;
    }
    out.push({ role: m.role, content: flattenContent(m.content) });
  }
  return out;
}

function safeParse(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Allowed primitive types in `@qvac/sdk`'s tool-parameter schema. */
const QVAC_PARAM_TYPES = new Set(["string", "number", "boolean", "object", "array", "integer"]);

/** OpenAI tools → flat `@qvac/sdk` tools. Best-effort: nested `items`/sub-properties are dropped
 *  (the SDK schema is one level deep) — fine for the flat starter tool set. */
function toQvacTools(tools: OpenAITool[]): QvacTool[] {
  return tools
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) => {
      const params = (t.function.parameters ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
      const props: QvacTool["parameters"]["properties"] = {};
      for (const [key, raw] of Object.entries(params.properties ?? {})) {
        const t0 = String((raw as { type?: unknown }).type ?? "string");
        const type = QVAC_PARAM_TYPES.has(t0) ? t0 : "string";
        const entry: { type: string; description?: string; enum?: string[] } = { type };
        const desc = (raw as { description?: unknown }).description;
        if (typeof desc === "string") entry.description = desc;
        const en = (raw as { enum?: unknown }).enum;
        if (Array.isArray(en)) entry.enum = en.map((v) => String(v));
        props[key] = entry;
      }
      return {
        type: "function" as const,
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: { type: "object" as const, properties: props, ...(params.required ? { required: params.required } : {}) },
      };
    });
}

const enc = new TextEncoder();

/** A single OpenAI `chat.completion.chunk` SSE frame. */
function sseChunk(id: string, model: string, created: number, delta: Record<string, unknown>, finishReason?: string): Uint8Array {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
  return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Drive `completion()` and translate its ordered event stream into an OpenAI SSE byte stream that
 * `@ai-sdk/openai-compatible` parses. Maps `contentDelta`→`delta.content`,
 * `thinkingDelta`→`delta.reasoning_content`, `toolCall`→a complete `delta.tool_calls[0]` (the SDK
 * gives whole calls, not argument deltas), then a terminating `finish_reason` + `[DONE]`.
 */
function eventsToOpenAISse(run: { events: AsyncIterable<CompletionEvent> }, model: string): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let toolIndex = 0;
  let sawTool = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Lead frame establishes the assistant role (OpenAI streaming convention).
        controller.enqueue(sseChunk(id, model, created, { role: "assistant" }));
        for await (const ev of run.events as AsyncIterable<Record<string, unknown>>) {
          const type = ev["type"] as string;
          if (type === "contentDelta") {
            controller.enqueue(sseChunk(id, model, created, { content: ev["text"] as string }));
          } else if (type === "thinkingDelta") {
            controller.enqueue(sseChunk(id, model, created, { reasoning_content: ev["text"] as string }));
          } else if (type === "toolCall") {
            sawTool = true;
            const call = ev["call"] as { id?: string; name?: string; arguments?: unknown };
            controller.enqueue(
              sseChunk(id, model, created, {
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: call.id ?? `call_${toolIndex}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                  },
                ],
              }),
            );
          } else if (type === "toolError") {
            const err = ev["error"] as { message?: string } | undefined;
            console.warn("[qvac-bridge] toolError:", err?.message ?? "unknown");
          }
          // contentStats / done events need no SSE frame.
        }
        controller.enqueue(sseChunk(id, model, created, {}, sawTool ? "tool_calls" : "stop"));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: (e as Error)?.message ?? String(e) } })}\n\n`));
        } catch {
          /* controller already closed */
        }
        controller.error(e);
      }
    },
  });
}

/**
 * The custom `fetch` handed to `createOpenAICompatible`. Answers `/v1/chat/completions` from the
 * on-device model; everything else 404s (embeddings ride a separate path — see `embeddingModel`).
 */
const qvacFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (!url.includes("/chat/completions")) {
    return new Response(JSON.stringify({ error: { message: `qvac-bridge: unsupported endpoint ${url}` } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const raw = typeof init?.body === "string" ? init.body : "";
  const body = (raw ? JSON.parse(raw) : {}) as {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    stream?: boolean;
  };

  const modelId = body.model;
  const history = toQvacHistory(body.messages ?? []);
  const tools = body.tools && body.tools.length > 0 ? toQvacTools(body.tools) : undefined;

  // Cast to the SDK param type: our `QvacTool` validates property `type` at runtime (QVAC_PARAM_TYPES)
  // but is typed as `string`, which doesn't structurally satisfy the SDK's narrower enum.
  const run = completion({ modelId, history, stream: true, ...(tools ? { tools } : {}) } as Parameters<typeof completion>[0]);

  if (body.stream === false) {
    // generateText / non-streaming callers (e.g. plan pipeline) expect one full completion JSON.
    const final = await run.final;
    const message: Record<string, unknown> = { role: "assistant", content: final.contentText ?? "" };
    if (final.toolCalls && final.toolCalls.length > 0) {
      message["tool_calls"] = final.toolCalls.map((c, i) => ({
        id: c.id ?? `call_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }));
      message["content"] = final.contentText ?? null;
    }
    const payload = {
      id: `chatcmpl-${Math.floor(Math.random() * 1e9).toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, message, finish_reason: message["tool_calls"] ? "tool_calls" : "stop" }],
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }

  return new Response(eventsToOpenAISse(run, modelId), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}) as unknown as typeof fetch;

/** The on-device OpenAI-compatible provider, backed by `qvacFetch` (no network). */
export const qvacProvider = createOpenAICompatible({
  name: "qvac",
  baseURL: QVAC_BASE,
  apiKey: "qvac",
  fetch: qvacFetch,
});

/**
 * An on-device chat `LanguageModel` for the given loaded `modelId`, with `<think>` reasoning split
 * into reasoning parts — the phone-side mirror of `provider.ts`'s `chatModel()`.
 */
export function deviceChatModel(modelId: string): LanguageModel {
  return wrapLanguageModel({
    model: qvacProvider(modelId),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/**
 * A BORROWED chat `LanguageModel` (Stage 3): the heavy model runs on a mesh peer's serve, while the
 * agent loop + tool execution stay on the phone. The custom fetch drives `meshForward` (the per-pair
 * forward transport) and translates its frames back into OpenAI SSE: `onChunk` text → `delta.content`
 * (diffed to deltas), `onDelta.tool_calls` → `delta.tool_calls` (relayed verbatim — the AI SDK
 * accumulates them). `<think>` arrives inline in the peer's content and is split by the middleware, so
 * borrowed turns get the same reasoning panel as local ones. Tools execute locally; the multi-step
 * loop re-sends the growing history through this same model, one forward call per step (sequential —
 * which honours `meshForward`'s single-in-flight constraint).
 */
export function meshChatModel(opts: { providerKey: string; consumerKey: string; alias: string }): LanguageModel {
  const meshFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: `qvac-mesh-bridge: unsupported endpoint ${url}` } }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = (raw ? JSON.parse(raw) : {}) as { model: string; messages: OpenAIMessage[]; tools?: OpenAITool[]; tool_choice?: unknown; parallel_tool_calls?: unknown };
    const id = `chatcmpl-${Math.floor(Math.random() * 1e9).toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    let prevText = "";
    let sawTool = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseChunk(id, body.model, created, { role: "assistant" }));
        meshForward({
          providerKey: opts.providerKey,
          consumerKey: opts.consumerKey,
          model: body.model,
          messages: body.messages as unknown as { role: string; content: unknown }[],
          ...(body.tools ? { tools: body.tools as unknown[] } : {}),
          ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
          ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
          onChunk: (full) => {
            const delta = full.slice(prevText.length);
            prevText = full;
            if (delta.length > 0) controller.enqueue(sseChunk(id, body.model, created, { content: delta }));
          },
          onDelta: (d) => {
            if (d.tool_calls && d.tool_calls.length > 0) {
              sawTool = true;
              controller.enqueue(sseChunk(id, body.model, created, { tool_calls: d.tool_calls }));
            }
          },
        })
          .then(() => {
            controller.enqueue(sseChunk(id, body.model, created, {}, sawTool ? "tool_calls" : "stop"));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          })
          .catch((e) => {
            try {
              controller.error(e);
            } catch {
              /* already closed */
            }
          });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }) as unknown as typeof fetch;

  const provider = createOpenAICompatible({ name: "qvac-mesh", baseURL: QVAC_BASE, apiKey: "qvac", fetch: meshFetch });
  return wrapLanguageModel({ model: provider(opts.alias), middleware: extractReasoningMiddleware({ tagName: "think" }) });
}
