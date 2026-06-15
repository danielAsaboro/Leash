/**
 * Unit self-test for the pure pieces (no behavior mocks — hard-rule 4). Runs the access guard,
 * the 4096-char chunker, the SSE framer, and the answer reducer against realistic fixtures.
 *
 *   npm run test -w @mycelium/leash-telegram      (or: npm run telegram:test from root)
 *
 * The live transport (real bot token + real /api/leash/chat) is exercised by running the daemon
 * — see main.ts. This file gates the logic that's cheap to verify deterministically.
 */
import assert from "node:assert/strict";
import { isOwner } from "./access.ts";
import { chunkText, TG_MAX } from "./render.ts";
import { createSseParser, extractAnswer } from "./leash-client.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── access guard ────────────────────────────────────────────────────────────────────
test("isOwner: allowlist permits only listed ids", () => {
  const cfg = { dmPolicy: "allowlist" as const, allowFrom: [123] };
  assert.equal(isOwner(cfg, 123), true);
  assert.equal(isOwner(cfg, 999), false);
});
test("isOwner: open allows anyone, disabled blocks everyone", () => {
  assert.equal(isOwner({ dmPolicy: "open", allowFrom: [] }, 5), true);
  assert.equal(isOwner({ dmPolicy: "disabled", allowFrom: [5] }, 5), false);
});

// ── chunker ─────────────────────────────────────────────────────────────────────────
test("chunkText: empty → [], short → single", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("hello"), ["hello"]);
});
test("chunkText: long text splits into <=4096-char chunks", () => {
  const para = "word ".repeat(2000).trim(); // ~10000 chars
  const chunks = chunkText(para);
  assert.ok(chunks.length >= 2, "should split into multiple chunks");
  for (const c of chunks) assert.ok(c.length <= TG_MAX, `chunk ${c.length} exceeds ${TG_MAX}`);
  // No words lost (whitespace-normalized join equals the source word stream).
  assert.equal(chunks.join(" ").split(/\s+/).join(" "), para.split(/\s+/).join(" "));
});
test("chunkText: prefers paragraph boundary", () => {
  const a = "A".repeat(3000);
  const b = "B".repeat(3000);
  const chunks = chunkText(`${a}\n\n${b}`);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});

// ── SSE framer ──────────────────────────────────────────────────────────────────────
test("createSseParser: frames complete data: events, holds partials", () => {
  const parse = createSseParser();
  // A split mid-event must not emit until the blank line arrives.
  assert.deepEqual(parse('data: {"type":"text-delta","delta":"Hi"}\n'), []);
  const out = parse('\ndata: [DONE]\n\n');
  assert.deepEqual(out, ['{"type":"text-delta","delta":"Hi"}', "[DONE]"]);
});

// ── answer reducer ──────────────────────────────────────────────────────────────────
test("extractAnswer: concatenates text-delta, ignores reasoning, reads totalTokens", () => {
  const payloads = [
    '{"type":"start"}',
    '{"type":"reasoning-delta","delta":"thinking..."}',
    '{"type":"text-start","id":"t1"}',
    '{"type":"text-delta","id":"t1","delta":"Hello"}',
    '{"type":"text-delta","id":"t1","delta":", world"}',
    '{"type":"text-end","id":"t1"}',
    '{"type":"message-metadata","messageMetadata":{"totalTokens":42}}',
    '{"type":"finish"}',
    "[DONE]",
  ];
  const { text, totalTokens } = extractAnswer(payloads);
  assert.equal(text, "Hello, world");
  assert.equal(totalTokens, 42);
});

console.log(`\n✅ leash-telegram selftest: ${passed} passed`);
