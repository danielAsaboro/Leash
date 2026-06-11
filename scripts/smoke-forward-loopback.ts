/**
 * B1a loopback smoke for the forward transport (apps/hypha/src/forward-control.ts). Spins a
 * ForwardControlServer (with a fake echo handler) + a ForwardControlClient in ONE process, both on
 * real Hyperswarms, and round-trips streamed forward requests over the P2P channel — proving the
 * per-pair topic join, holepunch, newline framing, async-generator consumer, and id-multiplexing of
 * concurrent requests, WITHOUT loading any model. (The provider-local serve proxy is B1b; the live
 * cross-machine vision borrow is B1c.)
 *
 *   npm run smoke:forward-loopback
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AuditLog } from "@mycelium/shared";
import { ForwardControlServer, ForwardControlClient, type ForwardRequest, type ForwardFrame } from "../apps/hypha/src/forward-control.ts";

const audit = { record: () => {} } as unknown as AuditLog;

const providerSeed = randomBytes(32).toString("hex");
const consumerSeed = randomBytes(32).toString("hex");
const providerKey = randomBytes(32).toString("hex"); // the provider's gossiped key (topic identity)
const consumerKey = randomBytes(32).toString("hex"); // the consumer's gossiped key

// Fake handler — stands in for the B1b local-serve proxy: echo the request's first message text back
// as chunks + a done frame. No model, no serve; this exercises the transport only.
const handler = async (req: ForwardRequest, send: (f: ForwardFrame) => void): Promise<void> => {
  const body = req.body as { messages?: Array<{ content?: string }> } | undefined;
  const text = body?.messages?.[0]?.content ?? "(no text)";
  for (const part of [text, " ", "[echo]"]) send({ id: req.id, type: "chunk", data: part });
  send({ id: req.id, type: "done", stats: { endpoint: req.endpoint } });
};

const server = new ForwardControlServer({ seed: providerSeed, audit, handler });
const client = new ForwardControlClient(() => consumerKey, consumerSeed, audit);

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

function reqFor(id: string, endpoint: string, content: string): ForwardRequest {
  return { id, endpoint, body: { model: "qwen3vl", messages: [{ role: "user", content }] } };
}

async function main(): Promise<void> {
  console.log("🚀 B1a — forward transport loopback (server + client, real Hyperswarms, one process)\n");
  await server.ready();
  await server.updateAllowedConsumers(providerKey, new Set([consumerKey]));
  console.log("   server up; consumer allow-listed; dialing over the per-pair topic…\n");

  const t0 = Date.now();
  const single = await collect(client.forward(providerKey, reqFor("1", "/v1/chat/completions", "ping")));
  assert.equal(single, "ping [echo]", `unexpected stream: "${single}"`);
  console.log(`✅ single forward — streamed "${single}" (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Two concurrent forwards over the ONE reused connection — proves id-multiplexing.
  const [a, b] = await Promise.all([
    collect(client.forward(providerKey, reqFor("a", "/v1/chat/completions", "alpha"))),
    collect(client.forward(providerKey, reqFor("b", "/v1/embeddings", "beta"))),
  ]);
  assert.equal(a, "alpha [echo]", `mux A: "${a}"`);
  assert.equal(b, "beta [echo]", `mux B: "${b}"`);
  console.log(`✅ concurrent forwards multiplexed — A="${a}", B="${b}"`);

  console.log("\n🎉 FORWARD LOOPBACK GO — topic join + holepunch + newline framing + multiplexed streaming proven.");
}

main()
  .catch((e) => {
    console.error("❌ smoke failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    void client.close();
    void server.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
