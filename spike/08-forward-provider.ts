/**
 * SP2 Option B — B0 spike, PROVIDER side. A Hyperswarm "forward" server: receives an OpenAI chat
 * request (image inline as a base64 data-URL) over a P2P channel, runs the completion LOCALLY —
 * materializing the image on THIS disk → `attachments` (the user's serve-patch logic, provider-side) —
 * and streams the caption back. This is the bytes-in-body path that fixes cross-machine vision (SDK
 * `loadModel(delegate)` ships attachments by PATH, which the provider can't read off the consumer).
 * Spawned by spike/08-forward-vision.ts.
 */
import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Hyperswarm from "hyperswarm";
import { loadModel, completion, QWEN3VL_2B_MULTIMODAL_Q4_K } from "@qvac/sdk";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const MMPROJ = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "qvac.config.base.json"), "utf8")) as { serve?: { models?: Record<string, { config?: { projectionModelSrc?: string } }> } };
    const p = cfg.serve?.models?.["qwen3vl"]?.config?.projectionModelSrc;
    return p ? p.replace(/^~/, homedir()) : undefined;
  } catch {
    return undefined;
  }
})();
const TOPIC = createHash("sha256").update("hypha-forward-spike-v1").digest();

interface Part {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}
interface Msg {
  role: string;
  content: string | Part[];
}

/** OpenAI messages → SDK history; decode any data-URL image to a temp file ON THIS (provider) disk. */
function toHistory(messages: Msg[]): { history: unknown[]; tmp: string[] } {
  const tmp: string[] = [];
  const history = (messages ?? []).map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    let text = "";
    const attachments: { path: string }[] = [];
    for (const part of m.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text;
      const url = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
      const mm = typeof url === "string" ? /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url) : null;
      if (mm) {
        const ext = mm[1]!.toLowerCase() === "image/jpeg" ? "jpg" : "png";
        const f = join(tmpdir(), `fwd-img-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}.${ext}`);
        writeFileSync(f, Buffer.from(mm[2]!, "base64"));
        tmp.push(f);
        attachments.push({ path: f });
      }
    }
    return attachments.length ? { role: m.role, content: text, attachments } : { role: m.role, content: text };
  });
  return { history, tmp };
}

let modelId: string | undefined;
async function ensureModel(): Promise<string> {
  if (!modelId) modelId = await loadModel({ modelSrc: QWEN3VL_2B_MULTIMODAL_Q4_K, modelType: "llm", modelConfig: { ctx_size: 8192, projectionModelSrc: MMPROJ }, onProgress: () => {} } as Parameters<typeof loadModel>[0]);
  return modelId;
}

const swarm = new Hyperswarm();
swarm.on("connection", (conn: { on: (e: string, f: (c: Buffer) => void) => void; write: (s: string) => void }) => {
  let buf = "";
  conn.on("error", () => {});
  conn.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts.filter(Boolean)) {
      let req: { id?: string; body?: { messages?: Msg[] } };
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const send = (o: object) => conn.write(JSON.stringify({ id: req.id, ...o }) + "\n");
      void (async () => {
        const { history, tmp } = toHistory(req.body?.messages ?? []);
        try {
          const id = await ensureModel();
          const run = completion({ modelId: id, history, stream: true } as Parameters<typeof completion>[0]);
          for await (const tok of run.tokenStream) send({ type: "chunk", data: tok });
          send({ type: "done" });
        } catch (e) {
          send({ type: "error", error: e instanceof Error ? e.message : String(e) });
        } finally {
          for (const f of tmp) {
            try {
              unlinkSync(f);
            } catch {
              /* best-effort */
            }
          }
        }
      })();
    }
  });
});
swarm.join(TOPIC, { server: true, client: false });
await swarm.flush();
console.log("FORWARD-PROVIDER-READY");
process.stdin.resume();
