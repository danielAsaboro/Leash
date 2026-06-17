/** tsx assertion script. Run: npx tsx apps/web/scripts/agent-memory.test.ts */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const base = mkdtempSync(join(tmpdir(), "agent-mem-"));
  process.env["LEASH_AGENT_MEMORY_DIR"] = base;
  const { memoryDir, readMemoryContext, agentMemoryTools } = await import("../lib/leash/agent-memory.ts");

  // 1. dir path
  assert.strictEqual(memoryDir("coder"), join(base, "coder"), "memoryDir path");

  // 2. readMemoryContext: empty when absent, content + cap when present
  assert.strictEqual(await readMemoryContext("nope"), "", "absent ⇒ empty");
  mkdirSync(join(base, "coder"), { recursive: true });
  writeFileSync(join(base, "coder", "MEMORY.md"), "line1\nline2\n");
  const ctx = await readMemoryContext("coder");
  assert.ok(ctx.includes("line1") && ctx.includes("line2"), "context includes MEMORY.md");
  assert.ok(/persistent memory/i.test(ctx), "context is wrapped/labelled");

  // 3. tools: write within dir works; path traversal rejected
  const tools = agentMemoryTools("coder") as unknown as Record<string, { execute: (a: any) => Promise<any> }>;
  await tools["write_memory"]!.execute({ file: "MEMORY.md", content: "hello" });
  assert.strictEqual(readFileSync(join(base, "coder", "MEMORY.md"), "utf8"), "hello", "write within dir");
  const bad = await tools["write_memory"]!.execute({ file: "../escape.txt", content: "x" });
  assert.ok(/refus|outside|invalid/i.test(JSON.stringify(bad)), "traversal rejected");
  const readBack = await tools["read_memory"]!.execute({ file: "MEMORY.md" });
  assert.ok(JSON.stringify(readBack).includes("hello"), "read within dir");

  rmSync(base, { recursive: true });
  console.log("agent-memory: PASS");
}
main();
