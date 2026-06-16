/**
 * Offline end-to-end smoke for the plugin system (no serve / no mesh needed) — exercises the REAL
 * leash-core store code: stage a folder plugin → install (quarantine) → review → enable → confirm the
 * components surface namespaced through the existing reads → confirm the skills slug dispatcher →
 * uninstall. Run: `npx tsx scripts/smoke-plugins.ts`
 */
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the stores in a throwaway data dir BEFORE importing leash-core (paths read env at import).
const DATA = await mkdtemp(join(tmpdir(), "leash-smoke-"));
process.env["LEASH_DATA_DIR"] = DATA;

const { installStagedPlugin, listPlugins, getPlugin, setPluginEnabled, removePlugin, pluginSkills, pluginMcpServers, pluginAgents, PLUGINS_DIR } = await import("@mycelium/leash-core/plugins-store");
const { listSkills, getSkill, readSkillFile } = await import("@mycelium/leash-core/skills-store");
const { listAgents } = await import("@mycelium/leash-core/agents-store");

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

// ── Build a realistic test plugin tree ────────────────────────────────────────
const src = await mkdtemp(join(tmpdir(), "test-plugin-"));
await mkdir(join(src, ".claude-plugin"), { recursive: true });
await writeFile(join(src, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "Demo Pack", version: "1.2.0", description: "A demo plugin", enabled: true }));
await mkdir(join(src, "skills", "greet", "references"), { recursive: true });
await writeFile(join(src, "skills", "greet", "SKILL.md"), `---\nname: Greet\ndescription: Greets the user warmly\nenabled: true\n---\n\nSay hello nicely. See references/note.md.`);
await writeFile(join(src, "skills", "greet", "references", "note.md"), "Be warm.");
await mkdir(join(src, "agents"), { recursive: true });
await writeFile(join(src, "agents", "reviewer.md"), `---\nname: Reviewer\ndescription: Reviews text for issues\ntools: [bash]\nmax-turns: 4\n---\n\nYou are a careful reviewer.`);
await writeFile(join(src, ".mcp.json"), JSON.stringify({ demo: { type: "stdio", command: "${CLAUDE_PLUGIN_ROOT}/server.js", args: ["--port", "0"] } }));

// ── Install → quarantine ──────────────────────────────────────────────────────
const entry = await installStagedPlugin(src, { kind: "folder", ref: src });
check("install returns an entry", !!entry);
check("id derived from manifest name (demo-pack)", entry.id === "demo-pack");
check("quarantined: enabled === false", entry.enabled === false);
check("version/description captured", entry.version === "1.2.0" && entry.description === "A demo plugin");
check("inventory: 1 skill, 1 mcp, 1 agent", entry.components.skills.length === 1 && entry.components.mcpServers.length === 1 && entry.components.agents.length === 1);
check("tree copied under PLUGINS_DIR", await stat(join(PLUGINS_DIR, "demo-pack", "skills", "greet", "SKILL.md")).then(() => true, () => false));

// Re-install must throw code:"exists"
let existsThrown = false;
try {
  await installStagedPlugin(src, { kind: "folder", ref: src });
} catch (e) {
  existsThrown = (e as Error & { code?: string }).code === "exists";
}
check("re-install throws code:exists", existsThrown);

// ── Quarantine UX: disabled plugin contributes ZERO to a turn ──────────────────
check("disabled: pluginSkills all enabled=false", (await pluginSkills()).every((s) => !s.enabled));
check("disabled: listSkills shows greet but disabled", (await listSkills()).some((s) => s.slug === "demo-pack:greet" && !s.enabled));
check("disabled: listAgents() empty (only enabled agents)", (await listAgents()).length === 0);
check("disabled: getSkill stamps enabled=false", (await getSkill("demo-pack:greet"))?.enabled === false);

// ── Enable → components surface ────────────────────────────────────────────────
await setPluginEnabled("demo-pack", true);
check("enabled: getPlugin reflects it", (await getPlugin("demo-pack"))?.enabled === true);

const skills = await listSkills();
const greet = skills.find((s) => s.slug === "demo-pack:greet");
check("enabled: namespaced skill in listSkills, enabled", !!greet && greet.enabled === true);
check("enabled: skill body read via dispatcher", (greet?.body ?? "").includes("Say hello"));
check("dispatcher: getSkill('demo-pack:greet') enabled=true", (await getSkill("demo-pack:greet"))?.enabled === true);

// Slug dispatcher: read a plugin-skill attachment under the plugin tree
const file = await readSkillFile("demo-pack:greet", "references/note.md");
check("dispatcher: readSkillFile resolves plugin attachment", file.ok && file.text.includes("Be warm"));

const mcp = await pluginMcpServers();
const demoMcp = mcp.find((m) => m.id === "plugin:demo-pack:demo");
check("enabled: MCP server surfaces with plugin: id", !!demoMcp && demoMcp.enabled === true);
check("MCP ${CLAUDE_PLUGIN_ROOT} expanded to absolute tree", !!demoMcp?.command?.startsWith(join(PLUGINS_DIR, "demo-pack")) && !demoMcp.command.includes("CLAUDE_PLUGIN_ROOT"));

const agents = await listAgents();
const reviewer = agents.find((a) => a.slug === "demo-pack:reviewer");
check("enabled: agent surfaces via listAgents", !!reviewer && reviewer.enabled === true);
check("agent frontmatter parsed (tools, max-turns)", reviewer?.tools.includes("bash") === true && reviewer?.maxTurns === 4);

// ── Uninstall → no orphans ─────────────────────────────────────────────────────
await removePlugin("demo-pack");
check("uninstall: registry row gone", (await listPlugins()).length === 0);
check("uninstall: tree removed", await stat(join(PLUGINS_DIR, "demo-pack")).then(() => false, () => true));
check("uninstall: skill no longer in listSkills", !(await listSkills()).some((s) => s.slug === "demo-pack:greet"));

// ── Cleanup ────────────────────────────────────────────────────────────────────
await rm(src, { recursive: true, force: true });
await rm(DATA, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
