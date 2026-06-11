/**
 * B1b/B2 smoke for the provider-side forward proxy (apps/hypha/src/forward-provider.ts) over the real
 * transport (forward-control.ts). A tiny fake "local serve" answers three endpoint shapes — chat (SSE),
 * embeddings (JSON), audio/speech (binary) — and the forward client must receive each correctly framed:
 * chat → token stream, embeddings → one JSON chunk, speech → base64 chunks reassembled to bytes. Proves
 * the proxy + per-shape framing + transport end-to-end WITHOUT a model (the live runs are B1c/B2 live).
 *
 *   npm run smoke:forward-provider
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AuditLog } from "@mycelium/shared";
import { ForwardControlServer, ForwardControlClient } from "../apps/hypha/src/forward-control.ts";
import { createForwardProvider } from "../apps/hypha/src/forward-provider.ts";

const audit = { record: () => {} } as unknown as AuditLog;
const TOKENS = ["A ", "cat ", "sits ", "on ", "a ", "mat."];

function startFakeServe(): Promise<{ url: string; close: () => void; lastSawImage: () => boolean }> {
  let sawImage = false;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const u = req.url ?? "";
        if (u.includes("/v1/embeddings")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }], model: "gte-large" }));
          return;
        }
        if (u.includes("/v1/audio/speech")) {
          res.writeHead(200, { "content-type": "audio/mpeg" });
          res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x01, 0x02, 0x03])); // fake mp3 (ID3 header)
          return;
        }
        sawImage = raw.includes("data:image/");
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const tok of TOKENS) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tok } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), lastSawImage: () => sawImage });
    });
  });
}

const providerSeed = randomBytes(32).toString("hex");
const consumerSeed = randomBytes(32).toString("hex");
const providerKey = randomBytes(32).toString("hex");
const consumerKey = randomBytes(32).toString("hex");

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

async function main(): Promise<void> {
  console.log("🚀 B1b/B2 — forward-provider proxy over the transport (fake serve, no model)\n");
  const serve = await startFakeServe();
  const server = new ForwardControlServer({ seed: providerSeed, audit, handler: createForwardProvider({ serveUrl: serve.url, audit }) });
  const client = new ForwardControlClient(() => consumerKey, consumerSeed, audit);
  try {
    await server.ready();
    await server.updateAllowedConsumers(providerKey, new Set([consumerKey]));
    console.log(`   fake serve on ${serve.url}; provider proxying to it; dialing…\n`);

    // 1) chat/vision — SSE → token stream (image rides inline)
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const visionBody = { model: "qwen3vl", messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: dataUrl } }] }] };
    const caption = await collect(client.forward(providerKey, { id: "1", endpoint: "/v1/chat/completions", body: visionBody }));
    assert.equal(caption, TOKENS.join(""), `caption: "${caption}"`);
    assert.ok(serve.lastSawImage(), "image data-URL did not cross inline");
    console.log(`✅ chat/vision — "${caption}" (image crossed inline)`);

    // 2) embeddings — JSON one chunk
    const embRaw = await collect(client.forward(providerKey, { id: "2", endpoint: "/v1/embeddings", body: { model: "gte-large", input: "hello" } }));
    const emb = JSON.parse(embRaw) as { data: Array<{ embedding: number[] }> };
    assert.ok(Array.isArray(emb.data[0]!.embedding) && emb.data[0]!.embedding.length === 4, "embeddings JSON not relayed");
    console.log(`✅ embeddings — vector[${emb.data[0]!.embedding.length}] relayed as one JSON chunk`);

    // 3) audio/speech — binary → base64 chunks reassembled
    const parts: Buffer[] = [];
    for await (const c of client.forward(providerKey, { id: "3", endpoint: "/v1/audio/speech", body: { model: "supertonic", input: "hi" } })) parts.push(Buffer.from(c, "base64"));
    const audioBytes = Buffer.concat(parts);
    assert.ok(audioBytes.length === 8 && audioBytes[0] === 0x49, `TTS bytes not reassembled (got ${audioBytes.length})`);
    console.log(`✅ audio/speech — ${audioBytes.length} binary bytes reassembled from base64 frames`);

    console.log("\n🎉 FORWARD-PROVIDER GO — chat/embeddings/speech all proxied + framed correctly over P2P.");
  } finally {
    void client.close();
    void server.close();
    serve.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  }
}

main().catch((e) => {
  console.error("❌ smoke failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
