/**
 * tsx assertion script. Run: npx tsx apps/web/scripts/agent-builtin.test.ts
 * Verifies the `builtin` flag parses from frontmatter and round-trips through saveAgent.
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  process.env["LEASH_AGENTS_DIR"] = dir; // AGENTS_DIR is read at module load — set BEFORE import
  const { getUserAgent, saveAgent } = await import("@mycelium/leash-core/agents-store");

  // 1. builtin: true in frontmatter parses to builtin === true
  writeFileSync(join(dir, "spec-one.md"), "---\nname: SpecOne\ndescription: d\nbuiltin: true\nenabled: true\n---\nbody");
  const a = await getUserAgent("spec-one");
  assert.ok(a, "spec-one should load");
  assert.strictEqual(a!.builtin, true, "builtin: true frontmatter → builtin === true");

  // 2. absent builtin → builtin === false
  writeFileSync(join(dir, "spec-two.md"), "---\nname: SpecTwo\ndescription: d\nenabled: true\n---\nbody");
  const b = await getUserAgent("spec-two");
  assert.strictEqual(b!.builtin, false, "no builtin frontmatter → builtin === false");

  // 3. saveAgent({ builtin: true }) round-trips (serializeAgent preserves it)
  await saveAgent({ slug: "spec-three", name: "SpecThree", description: "d", body: "x", builtin: true });
  const c = await getUserAgent("spec-three");
  assert.strictEqual(c!.builtin, true, "saveAgent(builtin:true) → getUserAgent builtin === true");

  // 4. saveAgent without builtin defaults to false
  await saveAgent({ slug: "spec-four", name: "SpecFour", description: "d", body: "x" });
  const d = await getUserAgent("spec-four");
  assert.strictEqual(d!.builtin, false, "saveAgent without builtin → builtin === false");

  rmSync(dir, { recursive: true });
  console.log("agent-builtin: PASS");
}
main();
