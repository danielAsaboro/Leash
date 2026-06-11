/**
 * SP2 Option B — B0 spike, ORCHESTRATOR + CONSUMER. Spawns the forward provider, then connects over
 * the Hyperswarm "forward" channel and sends an OpenAI vision request with the image inline (base64
 * data-URL in the body). The provider runs the completion LOCALLY and streams the caption back.
 *
 *   npm run spike:forward:vision
 *
 * GO = a real caption comes back over the channel → the bytes-in-body forward path works, so vision
 * (and by the same mechanism embeddings/STT/TTS) IS borrowable cross-machine. This is the core of
 * Option B (the SDK's delegated attachments are path-only and can't cross — proven in spike 07).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Hyperswarm from "hyperswarm";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const TSX = join(ROOT, "node_modules/.bin/tsx");
const TOPIC = createHash("sha256").update("hypha-forward-spike-v1").digest();
const IMG = ["spike/fixtures/ocr-note.png", "data/photos/calibration-card.png"].map((p) => join(ROOT, p)).find(existsSync);

function startProvider(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ["spike/08-forward-provider.ts"], { cwd: ROOT, env: process.env });
    let out = "";
    const t = setTimeout(() => reject(new Error("forward provider not ready in 90s")), 90_000);
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.includes("FORWARD-PROVIDER-READY")) {
        clearTimeout(t);
        resolve(child);
      }
    });
    child.stderr.on("data", (b: Buffer) => process.stderr.write(`[prov] ${b}`));
    child.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`forward provider exited early (${code})`));
    });
  });
}

let child: ChildProcess | undefined;
const swarm = new Hyperswarm();
try {
  if (!IMG) throw new Error("no image fixture found (spike/fixtures/ocr-note.png)");
  console.log("🚀 SP2 Option B — B0: forward an image-in-body request to a LOCAL-running provider\n");
  child = await startProvider();
  console.log("   forward provider ready; connecting over the P2P channel…\n");

  const dataUrl = "data:image/png;base64," + readFileSync(IMG).toString("base64");
  const req = {
    id: "1",
    endpoint: "/v1/chat/completions",
    body: {
      model: "qwen3vl",
      messages: [{ role: "user", content: [{ type: "text", text: "What is in this image? Answer in one short sentence." }, { type: "image_url", image_url: { url: dataUrl } }] }],
    },
  };

  const t0 = Date.now();
  const caption = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no response over the forward channel in 150s")), 150_000);
    swarm.on("connection", (conn: { on: (e: string, f: (c: Buffer) => void) => void; write: (s: string) => void }) => {
      let buf = "";
      let text = "";
      conn.on("error", () => {});
      conn.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts.filter(Boolean)) {
          let f: { type?: string; data?: string; error?: string };
          try {
            f = JSON.parse(line);
          } catch {
            continue;
          }
          if (f.type === "chunk") text += f.data ?? "";
          else if (f.type === "done") {
            clearTimeout(t);
            resolve(text);
          } else if (f.type === "error") {
            clearTimeout(t);
            reject(new Error(f.error ?? "provider error"));
          }
        }
      });
      conn.write(JSON.stringify(req) + "\n");
    });
    swarm.join(TOPIC, { client: true, server: false });
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (caption.trim()) {
    console.log(`✅ FORWARD VISION GO (${secs}s) — caption streamed over the P2P forward channel:`);
    console.log(`   “${caption.trim()}”`);
    console.log("\n→ Image bytes crossed in the request body; the provider ran vision LOCALLY. Option B works.");
  } else {
    console.log("⛔ NO-GO — empty caption over the forward channel.");
  }
} catch (e) {
  console.error("❌ B0 spike failed:", e instanceof Error ? e.message : e);
} finally {
  child?.kill("SIGINT");
  swarm.destroy().catch(() => {});
  setTimeout(() => process.exit(0), 500);
}
