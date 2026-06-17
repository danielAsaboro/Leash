/**
 * tsx assertion script. Run: npx tsx apps/web/scripts/specialist-agents.test.ts
 * Verifies each specialist builtin-agent file parses with the expected name/model/builtin.
 */
import assert from "node:assert";
import { mkdtempSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const SRC = join(here, "..", "builtin-agents");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "specialists-"));
  process.env["LEASH_AGENTS_DIR"] = dir;
  for (const f of readdirSync(SRC)) if (f !== "leash.md") copyFileSync(join(SRC, f), join(dir, f));
  const { getUserAgent } = await import("@mycelium/leash-core/agents-store");

  const expected: Record<string, { name: string; model: string }> = {
    health: { name: "Joy", model: "medpsy" },
    researcher: { name: "Sage", model: "" },
    summarizer: { name: "Bree", model: "" },
    coder: { name: "Grace", model: "" },
  };
  for (const [slug, exp] of Object.entries(expected)) {
    const a = await getUserAgent(slug);
    assert.ok(a, `${slug} should load`);
    assert.strictEqual(a!.name, exp.name, `${slug} name`);
    assert.strictEqual(a!.model, exp.model, `${slug} model`);
    assert.strictEqual(a!.builtin, true, `${slug} builtin`);
    assert.ok(a!.description.length > 10, `${slug} has a description (drives delegation)`);
  }
  rmSync(dir, { recursive: true });
  console.log("specialist-agents: PASS");
}
main();
