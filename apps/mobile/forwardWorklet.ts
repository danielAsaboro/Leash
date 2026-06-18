/**
 * React Native bridge to the forward Bare worklet (worklets/forward-worklet.mjs, bundled to
 * worklets/forward-worklet.bundle.js). Runs hyperswarm inside react-native-bare-kit and carries a raw
 * OpenAI request (text chat OR vision) to a mesh provider's forward server over the PRODUCTION per-pair
 * topic — so the provider answers from its already-resident serve model (no on-phone weights, no
 * duplicate load / registry contention on the provider). Single reusable worklet; one request in flight.
 */
/** Structured OpenAI streaming delta surfaced to tool-aware consumers (Stage 3). Mirrors the
 *  producer's `ForwardFrame` chunk `delta` field in apps/hypha/src/forward-control.ts. */
export type ForwardDelta = { content?: string; tool_calls?: unknown[]; finish_reason?: string | null };

type Pending = { onChunk?: (full: string) => void; onDelta?: (delta: ForwardDelta) => void; resolve: (s: string) => void; reject: (e: Error) => void; acc: string };

let worklet: any = null;
let ipc: any = null;
let ready = false;
let queued: string | null = null;
let pending: Pending | null = null;
let reqSeq = 0;

function decode(chunk: any): string {
  if (typeof chunk === "string") return chunk;
  try {
    return new TextDecoder().decode(chunk);
  } catch {
    let s = "";
    const a = chunk as Uint8Array;
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]!);
    try {
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  }
}

function encode(str: string): Uint8Array {
  try {
    return new TextEncoder().encode(str);
  } catch {
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  }
}

function handleFrame(f: any) {
  if (f?.type === "ready") {
    ready = true;
    if (queued != null) {
      ipc.write(encode(queued));
      queued = null;
    }
    return;
  }
  if (!pending) return;
  if (f?.type === "chunk") {
    // Legacy text path: always accumulate `data` and fire onChunk with the full text so far.
    pending.acc += f.data || "";
    pending.onChunk?.(pending.acc);
    // Stage 3: if the producer attached a structured OpenAI delta (tool_calls / finish_reason),
    // surface it to onDelta in addition to the text accumulation. No-op for plain-text consumers.
    if (f.delta && (f.delta.tool_calls !== undefined || f.delta.finish_reason !== undefined || f.delta.content !== undefined)) {
      pending.onDelta?.(f.delta as ForwardDelta);
    }
  } else if (f?.type === "done") {
    const p = pending;
    pending = null;
    p.resolve(p.acc);
  } else if (f?.type === "error") {
    const p = pending;
    pending = null;
    p.reject(new Error(f.error || "forward error"));
  }
}

function ensureWorklet() {
  if (worklet) return;
  // Lazy: neither the bundle string nor react-native-bare-kit touch the app's startup path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const FORWARD_BUNDLE: string = require("./worklets/forward-worklet.bundle.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worklet } = require("react-native-bare-kit");
  worklet = new Worklet();
  worklet.start("/forward.bundle", FORWARD_BUNDLE, []);
  ipc = worklet.IPC;
  let buf = "";
  ipc.on("data", (chunk: any) => {
    buf += decode(chunk);
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line) continue;
      let f: any;
      try {
        f = JSON.parse(line);
      } catch {
        continue;
      }
      handleFrame(f);
    }
  });
}

/** OpenAI message shape carried over the forward transport (text content, or a vision content array). */
export type ForwardMessage = { role: string; content: unknown };

/**
 * Borrow inference from a mesh provider's local serve over the forward transport. Generic over modality:
 * pass an OpenAI `messages` array (plain-text content for chat, or a content array with `image_url` parts
 * for vision). `onChunk` receives the FULL accumulated text so far (matching runCompletion's onToken).
 */
export function meshForward(opts: {
  providerKey: string;
  consumerKey: string;
  model: string;
  messages: ForwardMessage[];
  onChunk?: (full: string) => void;
  /** Stage 3 (tool-aware borrow): fired with each structured OpenAI delta (tool_calls / finish_reason)
   *  IN ADDITION to onChunk's text accumulation. Omit it and the legacy text-only path is unchanged. */
  onDelta?: (delta: ForwardDelta) => void;
  /** OpenAI tool-calling fields — relayed verbatim through hypha's forward transport to the peer serve. */
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  endpoint?: string;
  timeoutMs?: number;
}): Promise<string> {
  ensureWorklet();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise<string>((resolve, reject) => {
    if (pending) {
      reject(new Error("a mesh forward request is already in flight"));
      return;
    }
    const timer = setTimeout(() => {
      if (pending) {
        pending = null;
        reject(new Error("mesh forward timed out — is the provider's forward server running?"));
      }
    }, timeoutMs + 5_000);
    pending = {
      onChunk: opts.onChunk,
      onDelta: opts.onDelta,
      acc: "",
      resolve: (s) => {
        clearTimeout(timer);
        resolve(s);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    // Faithful OpenAI relay body: include tool-calling fields only when present so the legacy
    // text/vision body shape (model + messages) is byte-identical for callers that don't pass tools.
    const reqBody: Record<string, unknown> = { model: opts.model, messages: opts.messages };
    if (opts.tools !== undefined) reqBody.tools = opts.tools;
    if (opts.tool_choice !== undefined) reqBody.tool_choice = opts.tool_choice;
    if (opts.parallel_tool_calls !== undefined) reqBody.parallel_tool_calls = opts.parallel_tool_calls;
    const msg =
      JSON.stringify({
        id: `f${++reqSeq}`,
        providerKey: opts.providerKey,
        consumerKey: opts.consumerKey,
        endpoint: opts.endpoint ?? "/v1/chat/completions",
        body: reqBody,
        timeoutMs,
      }) + "\n";
    if (ready) ipc.write(encode(msg));
    else queued = msg;
  });
}

/**
 * Abort the in-flight forward request: drop the worklet's swarm connection so the phone unblocks
 * immediately (the pending promise resolves with the partial text). The PROVIDER still drains its
 * current decode to completion — the GPU-wedge rule (never abort the serve mid-token) means remote
 * compute can't be hard-killed; this only frees the client.
 */
export function abortMeshForward(): void {
  if (!worklet || !ipc || !pending) return;
  try {
    ipc.write(encode(JSON.stringify({ abort: true }) + "\n"));
  } catch {
    /* best-effort */
  }
}

/** Vision over the forward transport — builds the image content body and borrows it from `providerKey`. */
export function meshVision(
  providerKey: string,
  consumerKey: string,
  model: string,
  imageDataUrls: string[],
  prompt: string,
  onChunk?: (full: string) => void,
  timeoutMs = 180_000,
): Promise<string> {
  const content: unknown[] = [
    { type: "text", text: prompt || "What is in this image? Answer in one short sentence." },
    ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  return meshForward({ providerKey, consumerKey, model, messages: [{ role: "user", content }], onChunk, timeoutMs });
}
