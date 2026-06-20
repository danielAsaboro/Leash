/**
 * Offline smoke for the Psy/Joy health lane.
 * Run: npm run smoke:psy-health
 */
import assert from "node:assert";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isHealthIntent } from "../apps/web/lib/leash/conductor-core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentsDir = await mkdtemp(join(tmpdir(), "psy-agents-"));
const skillsDir = await mkdtemp(join(tmpdir(), "psy-skills-"));
process.env["LEASH_AGENTS_DIR"] = agentsDir;
process.env["LEASH_SKILLS_DIR"] = skillsDir;

await cp(join(here, "..", "apps", "web", "builtin-skills", "health-safety"), join(skillsDir, "health-safety"), { recursive: true });
await cp(join(here, "..", "apps", "web", "builtin-skills", "context-grounding"), join(skillsDir, "context-grounding"), { recursive: true });

const { getUserAgent, saveAgent } = await import("../packages/leash-core/src/agents-store.ts");
const { getSkill } = await import("../packages/leash-core/src/skills-store.ts");
const { splitFrontmatter, parseToolList } = await import("../packages/leash-core/src/frontmatter.ts");
const { tagsForAlias } = await import("../packages/leash-core/src/routing/index.ts");
const { toolPolicyDecision } = await import("../packages/leash-core/src/tool-policy.ts");

const healthRaw = await readFile(join(here, "..", "apps", "web", "builtin-agents", "health.md"), "utf8");
const healthDoc = splitFrontmatter(healthRaw);
assert.ok(healthDoc, "health builtin frontmatter parses");
await saveAgent({
  slug: "health",
  name: healthDoc!.fields["name"] ?? "Joy",
  description: healthDoc!.fields["description"] ?? "",
  body: healthDoc!.body,
  model: healthDoc!.fields["model"] ?? "",
  tools: parseToolList(healthDoc!.fields["tools"]),
  skills: (healthDoc!.fields["skills"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  maxTurns: Number(healthDoc!.fields["max-turns"] ?? 6),
  enabled: healthDoc!.fields["enabled"] !== "false",
  builtin: healthDoc!.fields["builtin"] === "true",
});

const joy = await getUserAgent("health");
assert.ok(joy, "Joy health agent loads");
assert.equal(joy!.name, "Joy");
assert.equal(joy!.model, "medpsy");
assert.deepEqual(joy!.tools, ["search_graph", "recall", "active_context", "activity_recent"], "Joy gets only read-only context tools");
assert.deepEqual(tagsForAlias("medpsy").specialist, "health", "medpsy is tagged as health specialist");

const safety = await getSkill("health-safety");
assert.ok(safety?.enabled, "health-safety skill loads");
assert.deepEqual(safety!.tools, joy!.tools, "health safety skill remains read-only");
assert.equal(isHealthIntent("I have chest pain and shortness of breath"), true, "health guard detects urgent health text");

for (const name of joy!.tools) assert.equal(toolPolicyDecision(name, { route: "health" }).ok, true, `${name} allowed in health route`);
for (const name of ["remember", "create_task", "get_app_state", "type_text", "deep_research"]) {
  assert.equal(toolPolicyDecision(name, { route: "health" }).ok, false, `${name} blocked in health route`);
}
assert.equal(toolPolicyDecision("recall", { route: "health", publicMesh: true }).ok, false, "private health context cannot route to public mesh");

await rm(agentsDir, { recursive: true, force: true });
await rm(skillsDir, { recursive: true, force: true });
console.log("smoke:psy-health PASS");
