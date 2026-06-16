/**
 * React Native bridge to the forward Bare worklet (worklets/forward-worklet.mjs, bundled
 * to worklets/forward-worklet.bundle.js). Runs hyperswarm inside react-native-bare-kit and
 * carries an image (base64) to a mesh forward provider for vision — the cross-machine path
 * the SDK's path-only delegate can't do. Single reusable worklet; one request in flight.
 */
type Pending = { onChunk?: (t: string) => void; resolve: (s: string) => void; reject: (e: Error) => void };

let worklet: any = null;
let ipc: any = null;
let ready = false;
let queued: string | null = null;
let pending: Pending | null = null;

function decode(chunk: any): string {
  if (typeof chunk === "string") return chunk;
  try {
    return new TextDecoder().decode(chunk);
  } catch {
    // utf8 fallback
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
  if (f?.type === "chunk") pending.onChunk?.(f.data || "");
  else if (f?.type === "done") {
    const p = pending;
    pending = null;
    p.resolve(f.text || "");
  } else if (f?.type === "error") {
    const p = pending;
    pending = null;
    p.reject(new Error(f.error || "forward error"));
  }
}

function ensureWorklet() {
  if (worklet) return;
  // Loaded lazily (only when mesh vision is first used) so neither the 728 KB bundle
  // string nor react-native-bare-kit touch the app's startup path.
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

/**
 * Send image(s) (base64 data URLs) to the mesh forward provider for a vision answer.
 * `imageDataUrl` (first image) keeps the current single-image worklet bundle working;
 * `imageDataUrls` (the full set) is forwarded too, ready for a multi-image worklet rebuild.
 */
export function meshVision(
  imageDataUrls: string[],
  prompt: string,
  onChunk?: (t: string) => void,
  timeoutMs = 180_000,
): Promise<string> {
  ensureWorklet();
  return new Promise<string>((resolve, reject) => {
    if (pending) {
      reject(new Error("a mesh-vision request is already in flight"));
      return;
    }
    const timer = setTimeout(() => {
      if (pending) {
        pending = null;
        reject(new Error("mesh vision timed out — is the forward provider running?"));
      }
    }, timeoutMs);
    pending = {
      onChunk,
      resolve: (s) => {
        clearTimeout(timer);
        resolve(s);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    const msg = JSON.stringify({ prompt, imageDataUrl: imageDataUrls[0], imageDataUrls }) + "\n";
    if (ready) ipc.write(encode(msg));
    else queued = msg;
  });
}
