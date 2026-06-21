import assert from "node:assert/strict";
import { exactIdentifierGraphHits, isStaleEmbeddingModelError } from "../src/graph.ts";

assert.equal(isStaleEmbeddingModelError(new Error('Failed to generate embeddings: Model with ID "abc123" not found')), true);
assert.equal(isStaleEmbeddingModelError(new Error("connection refused")), false);
assert.equal(isStaleEmbeddingModelError("Model with ID stale-worker-id not found"), true);

const literal = exactIdentifierGraphHits("verify batch QV-2026-0601", [
  { sourceId: "rpm", source: "car", kind: "chat", content: "Measured value 1726 rpm." },
  { sourceId: "greenhouse", source: "current-chat", kind: "chat", content: "Sensor 24 degrees; batch QV-2026-0601." },
]);
assert.deepEqual(literal.map((hit) => hit.source), ["current-chat"]);

console.log("graph-stale-model.test.ts: ok");
