/**
 * tsx assertion script (repo idiom). Run: npx tsx apps/web/scripts/main-agent.test.ts
 *
 * Note: imports CHAT_SYSTEM_PROMPT from prompt.ts (not tools.ts) because tools.ts
 * has `import "server-only"` which throws outside Next.js.
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMainAgentBase } from "../lib/leash/main-agent.ts";
import { CHAT_SYSTEM_PROMPT } from "../lib/leash/prompt.ts";

function main() {
  // 1. No-regression: body equals the constant byte-for-byte.
  const base = loadMainAgentBase();
  assert.strictEqual(base.body, CHAT_SYSTEM_PROMPT, "body must equal CHAT_SYSTEM_PROMPT");
  assert.strictEqual(base.model, "", "model must be empty string (resolvedChatAlias() fills it at runtime)");
  assert.strictEqual(base.name, "Leash", "name must be Leash");

  // 2. Fallback: missing file returns constants, never throws.
  const missing = loadMainAgentBase("/nonexistent/path/leash.md");
  assert.strictEqual(missing.body, CHAT_SYSTEM_PROMPT, "missing file -> CHAT_SYSTEM_PROMPT");
  assert.strictEqual(missing.model, "", "missing file → empty model");
  assert.strictEqual(missing.name, "Leash", "missing file → name Leash");

  // 3. Fallback: garbled file (no frontmatter block) returns constants.
  const tmp = mkdtempSync(join(tmpdir(), "leash-test-"));
  try {
    const garbled = join(tmp, "leash.md");
    writeFileSync(garbled, "no frontmatter here, just prose");
    const garbledResult = loadMainAgentBase(garbled);
    assert.strictEqual(garbledResult.body, CHAT_SYSTEM_PROMPT, "garbled file -> CHAT_SYSTEM_PROMPT");
    assert.strictEqual(garbledResult.model, "", "garbled file → empty model");
    assert.strictEqual(garbledResult.name, "Leash", "garbled file → name Leash");
  } finally {
    rmSync(tmp, { recursive: true });
  }

  // 4. Custom path with valid frontmatter is parsed correctly.
  const tmp2 = mkdtempSync(join(tmpdir(), "leash-test-"));
  try {
    const custom = join(tmp2, "leash.md");
    writeFileSync(custom, "---\nname: TestAgent\nmodel: test-alias\n---\nCustom body.");
    const customResult = loadMainAgentBase(custom);
    assert.strictEqual(customResult.name, "TestAgent", "custom name is parsed from frontmatter");
    assert.strictEqual(customResult.model, "test-alias", "custom model is parsed from frontmatter");
    assert.strictEqual(customResult.body, "Custom body.", "custom body is trimmed");
  } finally {
    rmSync(tmp2, { recursive: true });
  }

  console.log("main-agent: PASS");
}
main();
