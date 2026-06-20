/** tsx assertion script. Run: npx tsx apps/web/scripts/skills-store.test.ts */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builtinSkills = join(here, "..", "builtin-skills");

function manifest(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: Valid description\n${extra}---\n\nBody`;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "skills-store-"));
  process.env["LEASH_SKILLS_DIR"] = join(root, "skills");
  process.env["LEASH_SKILLS_STATE_FILE"] = join(root, "skills-state.json");
  process.env["LEASH_PLUGINS_DIR"] = join(root, "plugins");
  process.env["LEASH_PLUGINS_FILE"] = join(root, "plugins.json");
  const store = await import("../../../packages/leash-core/src/skills-store.ts");
  const { getSkill, saveSkill, importSkill, listSkills } = store;

  const writeSkill = (folder: string, raw: string) => {
    mkdirSync(join(process.env["LEASH_SKILLS_DIR"]!, folder), { recursive: true });
    writeFileSync(join(process.env["LEASH_SKILLS_DIR"]!, folder, "SKILL.md"), raw);
  };

  writeSkill(
    "valid-skill",
    manifest(
      "valid-skill",
      "license: Apache-2.0\ncompatibility: claude-code\nmetadata: |\n  {\"builtin\":true,\"examples\":[\"do the valid thing\",\"route to valid skill\"]}\nallowed-tools: Bash(git:*) Bash(jq:*) Read run_command\nwhen_to_use: |\n  use me\nargument-hint: topic\ndisable-model-invocation: true\nuser-invocable: false\ndisallowed-tools: Bash(rm:*)\nmodel: qwen3-4b\neffort: high\ncontext: |\n  extra context\nagent: helper\npaths: references/x.md\nshell: bash\nhooks: |\n  []\narguments: |\n  {\"topic\":\"string\"}\n",
    ),
  );
  const valid = await getSkill("valid-skill");
  assert.ok(valid, "valid skill should load");
  assert.strictEqual(valid!.name, "valid-skill", "name is preserved as the folder slug");
  assert.deepStrictEqual(valid!.tools, ["Bash(git:*)", "Bash(jq:*)", "Read", "run_command"], "allowed-tools keeps Claude patterns");
  assert.strictEqual(valid!.whenToUse, "use me", "when_to_use parses");
  assert.strictEqual(valid!.extras["disable-model-invocation"], "true", "Claude extension field round-trips");
  assert.strictEqual(valid!.extras["user-invocable"], "false", "user-invocable round-trips");
  assert.strictEqual(valid!.builtin, true, "builtin is derived from metadata");
  assert.deepStrictEqual(valid!.examples, ["do the valid thing", "route to valid skill"], "routing examples come from metadata");

  const invalidNames = ["Upper", "has space", "-leading", "trailing-", "two--hyphens", "a".repeat(65)];
  for (const [i, name] of invalidNames.entries()) {
    const folder = `invalid-${i}`;
    writeSkill(folder, manifest(name));
    assert.strictEqual(await getSkill(folder), null, `invalid name rejected: ${name}`);
  }

  writeSkill("folder-mismatch", manifest("other-name"));
  assert.strictEqual(await getSkill("folder-mismatch"), null, "name must match containing folder");

  writeSkill("missing-description", "---\nname: missing-description\n---\nBody");
  assert.strictEqual(await getSkill("missing-description"), null, "description is required");

  writeSkill("empty-description", "---\nname: empty-description\ndescription:   \n---\nBody");
  assert.strictEqual(await getSkill("empty-description"), null, "description cannot be empty");

  writeSkill("long-description", `---\nname: long-description\ndescription: ${"x".repeat(1025)}\n---\nBody`);
  assert.strictEqual(await getSkill("long-description"), null, "description max length is enforced");

  writeSkill("unknown-field", manifest("unknown-field", "examples: |\n  nope\n"));
  assert.strictEqual(await getSkill("unknown-field"), null, "unknown top-level fields are rejected");

  writeSkill("enabled-field", manifest("enabled-field", "enabled: true\n"));
  assert.strictEqual(await getSkill("enabled-field"), null, "enabled is app state, not SKILL.md frontmatter");

  const saved = await saveSkill({ name: "trip-planning", description: "Plan trips", enabled: true, body: "Steps" });
  assert.strictEqual(saved.slug, "trip-planning", "saveSkill accepts canonical names");
  assert.strictEqual(saved.name, "trip-planning", "saveSkill writes canonical names");
  assert.ok(!readFileSync(join(process.env["LEASH_SKILLS_DIR"]!, "trip-planning", "SKILL.md"), "utf8").includes("enabled:"), "saveSkill does not write enabled");
  await assert.rejects(() => saveSkill({ name: "Trip planning", description: "Plan trips", enabled: true, body: "Steps" }), /lowercase hyphenated/i, "saveSkill rejects display names");

  await assert.rejects(
    () => importSkill([{ path: "SKILL.md", data: Buffer.from(manifest("Trip planning")) }]),
    /lowercase hyphenated/i,
    "import rejects invalid package names instead of slugifying",
  );

  mkdirSync(join(process.env["LEASH_PLUGINS_DIR"]!, "plug-one", "skills", "bad-skill"), { recursive: true });
  writeFileSync(join(process.env["LEASH_PLUGINS_DIR"]!, "plug-one", "skills", "bad-skill", "SKILL.md"), manifest("Bad Skill"));
  writeFileSync(
    process.env["LEASH_PLUGINS_FILE"]!,
    JSON.stringify({
      plugins: [
        {
          id: "plug-one",
          name: "Plug One",
          source: { kind: "folder", ref: root },
          enabled: true,
          components: { skills: ["bad-skill"], mcpServers: [], agents: [] },
          installedAt: Date.now(),
        },
      ],
    }),
  );
  assert.ok(!(await listSkills()).some((s) => s.slug === "plug-one:bad-skill"), "invalid plugin skills are not surfaced");

  for (const folder of readdirSync(builtinSkills)) {
    const skillDir = join(builtinSkills, folder);
    if (!readFileSync(join(skillDir, "SKILL.md"), "utf8")) continue;
    const skill = await store.loadSkillFromDir(skillDir, folder);
    assert.ok(skill, `built-in ${folder} conforms`);
    assert.strictEqual(skill!.name, basename(skillDir), `built-in ${folder} name matches folder`);
    assert.strictEqual(skill!.builtin, true, `built-in ${folder} declares builtin metadata`);
  }

  rmSync(root, { recursive: true });
  console.log("skills-store: PASS");
}

main();
