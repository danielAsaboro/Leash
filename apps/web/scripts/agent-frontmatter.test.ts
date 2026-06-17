/** tsx assertion script. Run: npx tsx apps/web/scripts/agent-frontmatter.test.ts */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "agent-fm-"));
  process.env["LEASH_AGENTS_DIR"] = dir;
  const store = await import("@mycelium/leash-core/agents-store");
  const { getUserAgent, parseAgentMcpServers, parseMemoryScope } = store;

  // 1. mcpServers: empty-object value = reference; populated = inline (validated)
  const m = parseAgentMcpServers('{ "github": {}, "playwright": { "transport": "stdio", "command": "npx", "args": ["-y","@playwright/mcp"] } }');
  assert.deepStrictEqual(m.refs, ["github"], "empty value ⇒ reference");
  assert.strictEqual(m.inline.length, 1, "populated value ⇒ inline");
  assert.strictEqual(m.inline[0]!.name, "playwright", "inline name");
  assert.strictEqual(m.inline[0]!.command, "npx", "inline command validated");

  // 2. malformed mcpServers ⇒ empty, never throws
  assert.deepStrictEqual(parseAgentMcpServers("not json"), { refs: [], inline: [] }, "bad json ⇒ empty");

  // 3. memory scope
  assert.strictEqual(parseMemoryScope("user"), "user");
  assert.strictEqual(parseMemoryScope("PROJECT"), "project");
  assert.strictEqual(parseMemoryScope("bogus"), "", "junk ⇒ empty");

  // 4. camelCase AND kebab both parse; reserved fields stored raw; model never coerces
  writeFileSync(join(dir, "full.md"),
    "---\nname: Full\ndescription: d\n" +
    "disallowedTools: a, b\nmaxTurns: 9\n" +
    "permissionMode: dontAsk\ncolor: blue\nbackground: true\neffort: high\nisolation: worktree\ninitialPrompt: hi\n" +
    "memory: user\n" +
    "mcpServers: |\n  { \"github\": {} }\n---\nbody");
  const a = (await getUserAgent("full"))!;
  assert.deepStrictEqual(a.disallowedTools, ["a", "b"], "camelCase disallowedTools");
  assert.strictEqual(a.maxTurns, 9, "camelCase maxTurns");
  assert.strictEqual(a.permissionMode, "dontAsk", "reserved permissionMode stored");
  assert.strictEqual(a.color, "blue", "reserved color stored");
  assert.strictEqual(a.background, true, "reserved background bool");
  assert.strictEqual(a.effort, "high", "reserved effort stored");
  assert.strictEqual(a.isolation, "worktree", "reserved isolation stored");
  assert.strictEqual(a.initialPrompt, "hi", "reserved initialPrompt stored");
  assert.strictEqual(a.memory, "user", "memory scope");
  assert.deepStrictEqual(a.mcpServers.refs, ["github"], "mcpServers ref via block scalar");

  // 5. invalid reserved enum ⇒ empty (inert)
  writeFileSync(join(dir, "bad.md"), "---\nname: Bad\ndescription: d\npermissionMode: nonsense\ncolor: chartreuse\n---\nx");
  const b = (await getUserAgent("bad"))!;
  assert.strictEqual(b.permissionMode, "", "invalid permissionMode ⇒ empty");
  assert.strictEqual(b.color, "", "invalid color ⇒ empty");

  // 6. saveAgent persists + getUserAgent reads back the new fields (round-trip through serializeAgent)
  await store.saveAgent({ slug: "rt", name: "RT", description: "d", memory: "user", permissionMode: "plan", color: "pink", mcpServers: { refs: ["github"], inline: [] } });
  const rt = (await getUserAgent("rt"))!;
  assert.strictEqual(rt.memory, "user", "saveAgent persists memory");
  assert.strictEqual(rt.permissionMode, "plan", "saveAgent persists permissionMode");
  assert.strictEqual(rt.color, "pink", "saveAgent persists color");
  assert.deepStrictEqual(rt.mcpServers.refs, ["github"], "saveAgent persists mcpServers refs");

  rmSync(dir, { recursive: true });
  console.log("agent-frontmatter: PASS");
}
main();
