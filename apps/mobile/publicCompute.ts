import { Platform } from "react-native";

export type PublicProviderAdvert = {
  providerId: string;
  transportKey: string;
  lanEndpoints: Array<{ host: string; port: number }>;
  displayName: string;
  expiresAt: number;
  availability: { accepting: boolean; inflight: number; maxConcurrent: number };
  resources: { ramFreeMb: number; minHeadroomMb: number };
  pricing: { microsPerKiloToken: number };
  capabilities: Array<{ task: string; alias: string; contextWindow: number; tools: boolean }>;
};

const DIRECTORY = process.env.EXPO_PUBLIC_LEASH_PUBLIC_DIRECTORY ?? "";
const HEX32 = /^[0-9a-f]{64}$/i;
const isLanEndpoint = (value: unknown): value is { host: string; port: number } => {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as { host?: unknown; port?: unknown };
  if (typeof endpoint.host !== "string" || !Number.isInteger(endpoint.port) || (endpoint.port as number) < 1024 || (endpoint.port as number) > 65_535) return false;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(endpoint.host);
};

export type PublicProviderDiscovery = {
  advert: PublicProviderAdvert;
  discoveryMs: number;
  selectionReason: string;
};

export async function discoverPublicChatProvider(): Promise<PublicProviderDiscovery> {
  const started = Date.now();
  if (!DIRECTORY) throw new Error("no public compute directory is configured on this build");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try { response = await fetch(DIRECTORY, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`public discovery failed (${response.status})`);
  const body = await response.json() as { providers?: Array<{ advert?: PublicProviderAdvert }> };
  const now = Date.now();
  const candidates = (body.providers ?? []).flatMap((row) => row.advert ? [row.advert] : []).filter((advert) =>
    HEX32.test(advert.providerId)
    && HEX32.test(advert.transportKey)
    && Array.isArray(advert.lanEndpoints)
    && advert.lanEndpoints.length <= 8
    && advert.lanEndpoints.every(isLanEndpoint)
    && advert.expiresAt > now
    && advert.availability?.accepting
    && advert.availability.inflight < advert.availability.maxConcurrent
    && advert.pricing?.microsPerKiloToken === 0
    && advert.resources.ramFreeMb >= advert.resources.minHeadroomMb
    && advert.capabilities?.some((cap) => cap.task === "chat" && cap.alias === "chat"),
  );
  candidates.sort((a, b) =>
    a.pricing.microsPerKiloToken - b.pricing.microsPerKiloToken
    || (a.availability.inflight / a.availability.maxConcurrent) - (b.availability.inflight / b.availability.maxConcurrent)
    || (b.resources.ramFreeMb - b.resources.minHeadroomMb) - (a.resources.ramFreeMb - a.resources.minHeadroomMb)
    || a.providerId.localeCompare(b.providerId));
  if (!candidates[0]) throw new Error("no eligible public provider");
  const advert = candidates[0];
  const headroom = advert.resources.ramFreeMb - advert.resources.minHeadroomMb;
  return {
    advert,
    discoveryMs: Date.now() - started,
    selectionReason: `chat/chat · tools ${advert.capabilities.some((cap) => cap.task === "chat" && cap.tools) ? "yes" : "no"} · ${advert.pricing.microsPerKiloToken}µ/ktok · load ${advert.availability.inflight}/${advert.availability.maxConcurrent} · headroom ${headroom}MB`,
  };
}

type Pending = {
  acc: string;
  onChunk?: (full: string) => void;
  resolve: (value: { text: string; stats: Record<string, unknown>; jobId: string; requesterId: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
let worklet: any = null;
let ipc: any = null;
let ready = false;
let queued: string | null = null;
let pending: Pending | null = null;
let sequence = 0;

function decode(chunk: any): string { try { return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); } catch { return String(chunk); } }
function encode(value: string): Uint8Array { return new TextEncoder().encode(value); }

function ensureWorklet(): void {
  if (worklet) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bundle: string = Platform.OS === "android" ? require("./worklets/public-forward-worklet.android.bundle.js") : require("./worklets/public-forward-worklet.bundle.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worklet } = require("react-native-bare-kit");
  worklet = new Worklet();
  ipc = worklet.IPC;
  let buffer = "";
  ipc.on("data", (chunk: any) => {
    buffer += decode(chunk);
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      let frame: any; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === "ready") { ready = true; if (queued) { ipc.write(encode(queued)); queued = null; } continue; }
      if (!pending) continue;
      if (frame.type === "chunk") { pending.acc += frame.data || ""; pending.onChunk?.(pending.acc); }
      else if (frame.type === "done") { const current = pending; pending = null; clearTimeout(current.timer); current.resolve({ text: current.acc, stats: frame.stats ?? {}, jobId: frame.jobId, requesterId: frame.requesterId }); }
      else if (frame.type === "error") { const current = pending; pending = null; clearTimeout(current.timer); current.reject(new Error(frame.error || "public compute failed")); }
    }
  });
  ipc.on("error", (error: Error) => {
    ready = false;
    queued = null;
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(new Error(`public compute worklet failed: ${error.message}`));
  });
  // Subscribe before start: this worklet is small enough to emit its one-shot ready frame before a
  // post-start listener is attached, which leaves the first public request queued forever.
  worklet.start("/public-forward.bundle", bundle, []);
}

export function publicChat(opts: { advert: PublicProviderAdvert; messages: Array<{ role: string; content: unknown }>; onChunk?: (full: string) => void; timeoutMs?: number }): Promise<{ text: string; stats: Record<string, unknown>; jobId: string; requesterId: string }> {
  ensureWorklet();
  return new Promise((resolve, reject) => {
    if (pending) return reject(new Error("a public job is already in flight"));
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const timer = setTimeout(() => {
      if (!pending) return;
      pending = null;
      queued = null;
      reject(new Error(ready ? "timeout: public provider did not finish" : "timeout: public compute worklet did not become ready"));
    }, timeoutMs + 5_000);
    pending = { acc: "", onChunk: opts.onChunk, resolve, reject, timer };
    const message = JSON.stringify({ id: `p${++sequence}`, advert: opts.advert, timeoutMs, body: { model: "chat", messages: opts.messages, stream: true, max_tokens: 512 } }) + "\n";
    if (ready) ipc.write(encode(message)); else queued = message;
  });
}

export function abortPublicChat(): void { if (ipc && pending) ipc.write(encode(JSON.stringify({ abort: true }) + "\n")); }
