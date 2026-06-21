/** Cancel a live public QVAC stream after its first frame and prove the routed job terminates. */
import assert from "node:assert/strict";

const baseUrl = (process.env["LEASH_PUBLIC_CANCEL_URL"] ?? "http://127.0.0.1:12437/v1").replace(/\/+$/, "");
const controlUrl = (process.env["LEASH_PUBLIC_CANCEL_CONTROL_URL"] ?? baseUrl.replace(/\/v1$/, "")).replace(/\/+$/, "");
const controller = new AbortController();
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "chat",
    messages: [{ role: "user", content: "Write a detailed 400-word explanation of edge inference, one sentence at a time." }],
    routeMode: "public",
    sensitivity: "shareable",
    stream: true,
    max_tokens: 512,
  }),
  signal: controller.signal,
});

assert.equal(response.status, 200);
assert.equal(response.headers.get("x-leash-route"), "public");
const jobId = response.headers.get("x-leash-job-id");
assert.match(jobId ?? "", /^[0-9a-f-]{36}$/i);
const reader = response.body?.getReader();
assert.ok(reader, "public response omitted stream body");
const first = await reader.read();
assert.equal(first.done, false, "public stream ended before cancellation point");
assert.ok((first.value?.byteLength ?? 0) > 0, "public stream emitted no bytes before cancellation");
controller.abort(new Error("acceptance smoke cancellation"));
await reader.cancel().catch(() => undefined);

let evidence: Record<string, unknown> | null = null;
for (let attempt = 0; attempt < 30; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const check = await fetch(`${controlUrl}/public/compute/jobs/${jobId}`);
  if (!check.ok) continue;
  const body = await check.json() as { evidence?: Record<string, unknown> };
  evidence = body.evidence ?? null;
  if (evidence?.["state"] === "cancelled") break;
}

assert.equal(evidence?.["state"], "cancelled", `public job did not settle as cancelled: ${JSON.stringify(evidence)}`);
assert.equal(evidence?.["error"], "requester disconnected");
console.log(JSON.stringify({ ok: true, route: "public", jobId, state: evidence["state"], error: evidence["error"] }, null, 2));
