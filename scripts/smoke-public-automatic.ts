/** Prove automatic routing takes the live public tier and records the route actually used. */
import assert from "node:assert/strict";

const baseUrl = (process.env["LEASH_PUBLIC_AUTOMATIC_URL"] ?? "http://127.0.0.1:12437/v1").replace(/\/+$/, "");
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "chat",
    messages: [{ role: "user", content: "Reply briefly: automatic public route acceptance smoke." }],
    routeMode: "automatic",
    sensitivity: "shareable",
    stream: false,
    max_tokens: 16,
    temperature: 0,
  }),
  signal: AbortSignal.timeout(180_000),
});
const body = await response.json().catch(() => ({})) as Record<string, any>;
assert.equal(response.ok, true, `automatic route failed: ${response.status} ${JSON.stringify(body)}`);
const routing = body["leash_routing"] as Record<string, unknown> | undefined;
assert.equal(routing?.["route"], "public", "automatic route silently used a different compute tier");
assert.match(String(routing?.["jobId"] ?? ""), /^[0-9a-f-]{36}$/i, "automatic public route omitted job identity");
assert.match(String(routing?.["providerId"] ?? ""), /^[0-9a-f]{64}$/i, "automatic public route omitted provider identity");
assert.ok(String(routing?.["reason"] ?? "").includes("chat/chat"), "automatic public route omitted selection rationale");
assert.ok(["lan", "dht"].includes(String(routing?.["connectionTransport"] ?? "")), "automatic public route omitted transport evidence");
console.log(JSON.stringify({
  ok: true,
  intent: "automatic",
  actualRoute: routing?.["route"],
  jobId: routing?.["jobId"],
  providerId: routing?.["providerId"],
  reason: routing?.["reason"],
  connectionTransport: routing?.["connectionTransport"],
  requesterTtftMs: routing?.["requesterTtftMs"],
  tokensPerSecond: routing?.["tokensPerSecond"],
}, null, 2));
