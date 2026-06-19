/**
 * tsx assertion script. Run: npx tsx apps/web/scripts/specialist-agents.test.ts
 * Verifies each specialist builtin-agent file parses with the expected name/model/builtin.
 */
import assert from "node:assert";
import { mkdtempSync, copyFileSync, cpSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const SRC = join(here, "..", "builtin-agents");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "specialists-"));
  const skillsDir = mkdtempSync(join(tmpdir(), "health-skill-"));
  process.env["LEASH_AGENTS_DIR"] = dir;
  process.env["LEASH_SKILLS_DIR"] = skillsDir;
  for (const f of readdirSync(SRC)) if (f !== "leash.md") copyFileSync(join(SRC, f), join(dir, f));
  cpSync(join(here, "..", "builtin-skills", "health-safety"), join(skillsDir, "health-safety"), { recursive: true });
  const { getUserAgent } = await import("@mycelium/leash-core/agents-store");
  const { getSkill } = await import("@mycelium/leash-core/skills-store");

  const expected: Record<string, { name: string; model: string }> = {
    health: { name: "Joy", model: "medpsy" },
    researcher: { name: "Ruth", model: "" },
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
    assert.match(a!.body, /^@builtin-prompt:/, `${slug} body points at central prompt.ts text`);
  }
  const health = await getUserAgent("health");
  assert.deepStrictEqual(health!.tools, ["search_graph", "recall", "active_context", "activity_recent"], "health specialist gets only read-only context tools");
  assert.deepStrictEqual(health!.skills, ["context-grounding", "health-safety"], "health specialist preloads grounding + health safety skills");
  const skill = await getSkill("health-safety");
  assert.ok(skill, "health-safety skill should load");
  assert.deepStrictEqual(skill!.tools, ["search_graph", "recall", "active_context", "activity_recent"], "health-safety skill stays read-only");
  assert.ok(skill!.whenToUse.includes("urgent care"), "health-safety skill has health routing examples");
  rmSync(skillsDir, { recursive: true });
  rmSync(dir, { recursive: true });
  console.log("specialist-agents: PASS");
}
main();
