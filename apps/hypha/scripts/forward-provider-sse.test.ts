import assert from "node:assert/strict";
import type { ForwardFrame, ForwardRequest } from "../src/forward-control.ts";
import { streamSse } from "../src/forward-provider.ts";

const request: ForwardRequest = {
  id: "structured-sse-test",
  endpoint: "/v1/chat/completions",
  body: { model: "chat", messages: [{ role: "user", content: "Use both tools" }] },
};
const encoder = new TextEncoder();
const toolCalls = [
  { index: 0, id: "call-a", type: "function", function: { name: "public_calculate", arguments: "{\"expression\":\"6*7\"}" } },
  { index: 1, id: "call-b", type: "function", function: { name: "public_convert_units", arguments: "{\"value\":1,\"from\":\"km\",\"to\":\"m\"}" } },
];
const first = `data: ${JSON.stringify({ choices: [{ delta: { content: "\n" }, finish_reason: null }] })}\r\n\r\n`;
// Deliberately omit the trailing SSE separator and [DONE]. Some HTTP implementations close at
// exactly this boundary; the terminal tool delta must still be delivered before EOF.
const terminal = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}`;
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(first.slice(0, first.length - 1)));
    controller.enqueue(encoder.encode(first.slice(first.length - 1) + terminal));
    controller.close();
  },
});
const frames: ForwardFrame[] = [];
await streamSse(request, body, (frame) => frames.push(frame));

assert.equal(frames.length, 3);
assert.equal(frames[0]?.type, "chunk");
assert.equal(frames[1]?.type, "chunk");
assert.deepEqual(frames[1]?.type === "chunk" ? frames[1].delta?.tool_calls : undefined, toolCalls);
assert.equal(frames[1]?.type === "chunk" ? frames[1].delta?.finish_reason : undefined, "tool_calls");
assert.equal(frames[2]?.type, "done");
console.log("✅ forward provider SSE — CRLF and unterminated terminal tool_calls preserved");
