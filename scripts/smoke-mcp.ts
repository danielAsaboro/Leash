/**
 * Pure-logic smoke for the MCP integration core (apps/web/lib/leash/mcp-config.ts) — the
 * ONE validation/parse code path shared by the "Create Custom Integration" modal (runs in
 * the browser), the API route, and the store. Proves: per-transport validation + errors,
 * default naming, header/arg cleaning, the dedupe signature, and the lenient JSON importer
 * (both the bare `{ "<name>": {...} }` map and the `{ "mcpServers": {...} }` wrapper, with
 * `type`/`transport` aliases and per-entry error collection).
 *
 * The store's built-in non-deletable guard + the daemon-lifecycle toggle are effectful
 * (server-only + a spawned process) → proven by live acceptance, not here.
 *
 *   npm run smoke:mcp
 */
import assert from "node:assert/strict";
import { validateServerInput, parseMcpJson, formatMcpJson, serverSignature } from "../apps/web/lib/leash/mcp-config.ts";

// --- validateServerInput: http/sse ---------------------------------------------------
const http = validateServerInput({ url: "https://api.example.com/mcp", headers: { Authorization: "Bearer t" } });
assert.equal(http.transport, "http", "default transport is http");
assert.equal(http.name, "api.example.com/mcp", "name defaults to the URL host+path");
assert.deepEqual(http.headers, { Authorization: "Bearer t" }, "headers pass through");

const sse = validateServerInput({ transport: "sse", url: "http://localhost:9/sse", name: "Local" });
assert.equal(sse.transport, "sse", "sse honored");
assert.equal(sse.name, "Local", "explicit name wins");
assert.equal(sse.headers, undefined, "no headers → omitted (not {})");

assert.throws(() => validateServerInput({ url: "" }), /need a URL/, "empty URL rejected");
assert.throws(() => validateServerInput({ url: "ftp://nope" }), /http:\/\/ or https:\/\//, "non-http URL rejected");
assert.throws(() => validateServerInput({ transport: "carrier-pigeon", url: "https://x.y" }), /unknown server type/, "bad transport rejected");

// Empty header values are dropped (a blank row in the modal must not persist a key).
assert.equal(validateServerInput({ url: "https://x.y", headers: { A: "", B: "v" } }).headers?.["A"], undefined, "blank header value dropped");

// --- validateServerInput: stdio ------------------------------------------------------
const stdio = validateServerInput({ transport: "stdio", command: "npx", args: ["-y", "@mcp/fs", "/notes"], env: { KEY: "v" } });
assert.equal(stdio.transport, "stdio", "stdio honored");
assert.equal(stdio.name, "npx", "stdio name defaults to the command basename");
assert.deepEqual(stdio.args, ["-y", "@mcp/fs", "/notes"], "args pass through");
assert.deepEqual(stdio.env, { KEY: "v" }, "env passes through");
assert.equal(stdio.url, undefined, "stdio has no url");
assert.throws(() => validateServerInput({ transport: "stdio", command: "  " }), /need a command/, "blank command rejected");
assert.equal(validateServerInput({ transport: "stdio", command: "/usr/local/bin/server" }).name, "server", "command basename strips the path");

// --- serverSignature: dedupe key -----------------------------------------------------
assert.equal(serverSignature({ transport: "http", url: "https://a/mcp" }), serverSignature({ transport: "http", url: "https://a/mcp" }), "same url → same sig");
assert.notEqual(serverSignature({ transport: "http", url: "https://a" }), serverSignature({ transport: "sse", url: "https://a" }), "transport is part of the sig");
assert.equal(
  serverSignature({ transport: "stdio", command: "npx", args: ["a", "b"] }),
  serverSignature({ transport: "stdio", command: "npx", args: ["a", "b"] }),
  "stdio sig = command + args",
);
assert.notEqual(serverSignature({ transport: "stdio", command: "npx", args: ["a"] }), serverSignature({ transport: "stdio", command: "npx", args: ["b"] }), "different args → different sig");

// --- parseMcpJson: bare map ----------------------------------------------------------
const bare = parseMcpJson('{ "tavily": { "type": "http", "url": "https://api.tavily.com/mcp", "headers": { "Authorization": "Bearer k" } } }');
assert.equal(bare.ready.length, 1, "bare map: one server");
assert.equal(bare.errors.length, 0, "bare map: no errors");
assert.equal(bare.ready[0]?.key, "tavily", "key preserved");
assert.equal(bare.ready[0]?.server.transport, "http", "type→transport mapped");
assert.equal(bare.ready[0]?.server.name, "tavily", "name defaults to the JSON key");
assert.deepEqual(bare.ready[0]?.server.headers, { Authorization: "Bearer k" }, "headers parsed");

// --- parseMcpJson: mcpServers wrapper + stdio + transport alias -----------------------
const wrapped = parseMcpJson('{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@mcp/fs"] }, "remote": { "transport": "sse", "url": "https://r/sse" } } }');
assert.equal(wrapped.ready.length, 2, "wrapper: two servers");
const fs = wrapped.ready.find((r) => r.key === "fs");
assert.equal(fs?.server.transport, "stdio", "command-only entry → stdio");
assert.equal(wrapped.ready.find((r) => r.key === "remote")?.server.transport, "sse", "`transport` alias honored alongside `type`");

// --- parseMcpJson: per-entry errors don't sink the batch ------------------------------
const mixed = parseMcpJson('{ "good": { "url": "https://ok/mcp" }, "bad": { "url": "not-a-url" }, "alsobad": "stringnotobject" }');
assert.equal(mixed.ready.length, 1, "one good survives");
assert.equal(mixed.ready[0]?.key, "good", "the good one is good");
assert.equal(mixed.errors.length, 2, "two bad entries collected");
assert.ok(mixed.errors.some((e) => e.key === "bad" && /http/.test(e.error)), "bad url reported with reason");
assert.ok(mixed.errors.some((e) => e.key === "alsobad"), "non-object entry reported");

// --- parseMcpJson: whole-blob failures throw -----------------------------------------
assert.throws(() => parseMcpJson("{ not json"), /invalid JSON/, "garbage throws");
assert.throws(() => parseMcpJson("[1,2,3]"), /object of servers/, "array throws");

// --- formatMcpJson -------------------------------------------------------------------
assert.equal(formatMcpJson('{"a":1}'), '{\n  "a": 1\n}', "format reindents to 2-space");
assert.throws(() => formatMcpJson("{bad"), "format throws on bad json (drives the disabled button)");

console.log("✅ mcp-config — validate(http/sse/stdio)+errors · default names · header/env clean · dedupe sig · lenient JSON import(bare|wrapper, type|transport, partial errors) · format — GO");
