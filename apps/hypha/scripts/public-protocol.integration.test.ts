import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AuditLog } from "@mycelium/shared";
import { PUBLIC_COMPUTE_ADVERT_KIND, type PublicProviderAdvert } from "@mycelium/mesh";
import { PublicComputeClient, PublicComputeServer, PublicReplayGuard } from "../src/public-compute-control.ts";

const root = mkdtempSync(join(tmpdir(), "leash-public-protocol-"));
const audit = new AuditLog("public-protocol-test", root);
const seed = randomBytes(32).toString("hex");
const providerId = "a".repeat(64);
let releaseHeld!: () => void;
let held = new Promise<void>((resolve) => { releaseHeld = resolve; });
let minHeadroomMb = 0;
let serverTimeoutMs = 5_000;
let capOutputLimit = 32;

const server = new PublicComputeServer({
  seed,
  audit,
  replay: new PublicReplayGuard(join(root, "replay.json")),
  providerIds: () => new Set([providerId]),
  limits: () => ({ maxConcurrent: 1, maxRequestBytes: 64 * 1024, timeoutMs: serverTimeoutMs, minHeadroomMb }),
  lanPort: 0,
  lanHost: "127.0.0.1",
  validateCapability: (body) => body["model"] === "chat"
    ? { ok: true, alias: "chat", contextTokens: 32, outputLimit: capOutputLimit }
    : { ok: false, error: "chat capability required" },
  handler: async (req, send, signal) => {
    send({ id: req.id, type: "chunk", data: "hello", delta: { content: "hello" } });
    if (req.body["testMode"] === "structured") {
      send({ id: req.id, type: "chunk", data: "", delta: { tool_calls: [{ index: 0, id: "call-public", type: "function", function: { name: "public_calculate", arguments: "{\"expression\":\"6*7\"}" } }], finish_reason: "tool_calls" } });
    }
    if (req.body["testMode"] === "overflow") send({ id: req.id, type: "chunk", data: "overflow", delta: { content: "overflow" } });
    if (req.body["testMode"] === "hold") await Promise.race([held, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    if (signal.aborted) throw signal.reason ?? new Error("cancelled");
    send({ id: req.id, type: "done", stats: { fixture: true } });
  },
});
await server.ready();
let serverClosed = false;
const client = new PublicComputeClient(randomBytes(32).toString("hex"), audit);
const advert: PublicProviderAdvert = {
  version: 1, kind: PUBLIC_COMPUTE_ADVERT_KIND, cellId: "protocol-test", providerId,
  transportKey: server.transportKey, displayName: "protocol-provider", issuedAt: Date.now(), expiresAt: Date.now() + 30_000,
  lanEndpoints: [{ host: "127.0.0.1", port: server.lanPort }],
  nonce: "ab".repeat(16), availability: { accepting: true, inflight: 0, maxConcurrent: 1, queueDepth: 0 },
  resources: { ramTotalMb: 36_864, ramFreeMb: 20_000, minHeadroomMb: 2_048, maxRequestBytes: 64 * 1024 },
  privacy: { accepts: "shareable-only", retainsPrompts: false }, pricing: { microsPerKiloToken: 0 },
  capabilities: [{ task: "chat", alias: "chat", contextWindow: 4096, tools: true, maxOutputTokens: 32 }],
};

try {
  const normal = client.forwardFrames(advert, { model: "chat", messages: [{ role: "user", content: "hello" }] }, { timeoutMs: 10_000 });
  const first = await normal.next();
  assert.equal(first.done, false);
  assert.equal(first.value.data, "hello", "stream token traverses authenticated encrypted transport");
  const done = await normal.next();
  assert.equal(done.done, true);
  assert.equal(done.value["providerId"], providerId);
  assert.equal(done.value["transportKey"], server.transportKey);
  assert.equal(done.value["connectionTransport"], "lan", "signed LAN endpoint uses pinned Noise transport without DHT discovery");
  const providerAudit = readFileSync(audit.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { extra?: Record<string, unknown> });
  assert.ok(providerAudit.some((record) => record.extra?.["role"] === "public-provider" && record.extra?.["phase"] === "done" && record.extra?.["connectionTransport"] === "lan"), "provider audit records authenticated LAN ingress");

  const structured = client.forwardFrames(advert, { model: "chat", messages: [], testMode: "structured" }, { timeoutMs: 10_000 });
  assert.equal((await structured.next()).value.data, "hello");
  const structuredFrame = (await structured.next()).value;
  assert.equal(structuredFrame.delta?.finish_reason, "tool_calls");
  assert.equal(structuredFrame.delta?.tool_calls?.[0]?.function?.name, "public_calculate");
  assert.equal((await structured.next()).done, true);

  const wrongProvider = client.forwardFrames({ ...advert, providerId: "b".repeat(64) }, { model: "chat", messages: [] }, { timeoutMs: 10_000 });
  await assert.rejects(() => wrongProvider.next(), /authentication_failure/);

  const wrongCapability = client.forwardFrames(advert, { model: "vision", messages: [] }, { timeoutMs: 10_000 });
  await assert.rejects(() => wrongCapability.next(), /capability_mismatch/);

  const oversized = client.forwardFrames(advert, { model: "chat", messages: [], padding: "x".repeat(65_750) }, { timeoutMs: 10_000 });
  await assert.rejects(() => oversized.next(), /invalid_request.*byte limit/);

  capOutputLimit = 1;
  const outputLimited = client.forwardFrames(advert, { model: "chat", messages: [], testMode: "overflow" }, { timeoutMs: 10_000 });
  assert.equal((await outputLimited.next()).value.data, "hello");
  await assert.rejects(() => outputLimited.next(), /inference_failure.*output limit/);
  capOutputLimit = 32;

  serverTimeoutMs = 20;
  held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const timedOut = client.forwardFrames(advert, { model: "chat", messages: [], testMode: "hold" }, { timeoutMs: 10_000 });
  assert.equal((await timedOut.next()).value.data, "hello");
  await assert.rejects(() => timedOut.next(), /timeout.*public job timeout/);
  releaseHeld();
  serverTimeoutMs = 5_000;

  minHeadroomMb = Number.MAX_SAFE_INTEGER;
  const memoryOverloaded = client.forwardFrames(advert, { model: "chat", messages: [] }, { timeoutMs: 10_000 });
  await assert.rejects(() => memoryOverloaded.next(), /overloaded_provider.*memory headroom/);
  minHeadroomMb = 0;

  held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const holding = client.forwardFrames(advert, { model: "chat", messages: [], testMode: "hold" }, { timeoutMs: 10_000 });
  assert.equal((await holding.next()).value.data, "hello");
  const overloaded = client.forwardFrames(advert, { model: "chat", messages: [] }, { timeoutMs: 10_000 });
  await assert.rejects(() => overloaded.next(), /overloaded_provider/);
  await holding.return({});
  releaseHeld();

  held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const cancelled = client.forwardFrames(advert, { model: "chat", messages: [], testMode: "hold" }, { jobId: "12345678-1234-1234-1234-123456789abc", timeoutMs: 10_000 });
  assert.equal((await cancelled.next()).value.data, "hello");
  client.cancel(advert, "12345678-1234-1234-1234-123456789abc");
  await assert.rejects(() => cancelled.next(), /cancellation/);

  // The advert and authenticated connection were valid, then the provider vanished. A stale DHT
  // entry must not turn that into local success or hang indefinitely; reconnect fails explicitly.
  await server.close();
  serverClosed = true;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(() => client.connect(advert, 750), /unreachable_provider/);

  console.log("✅ public protocol — text + structured stream, Noise identity pin, provider auth, request/output limits, capability, overload, timeout, cancellation, provider-disappeared failure");
} finally {
  releaseHeld();
  await client.close();
  if (!serverClosed) await server.close();
}
