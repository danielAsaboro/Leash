/**
 * Domain end-to-end smoke — proves the user scenario at the layer that's verifiable OFFLINE: install
 * REAL law + medicine plugins, enable them, and confirm the general assistant gains specialist
 * components WITHOUT touching the harness — the plugin's skills surface namespaced into the existing
 * skill catalog (with the exact routing metadata the activation matcher consumes), its agents into
 * listAgents (the chat route turns each into a callable tool), its MCP server into the reconcile feed.
 * Disabling one plugin isolates it.
 *
 * Scope honesty: the activation DECISION (a law query → the law skill) and the model ANSWER run in the
 * web/Next runtime + `qvac serve` — they can't be imported under plain tsx (`@qvac/ai-sdk-provider`
 * needs Next's resolver; the embedding+chat legs need the serve). This proves everything UP TO that
 * boundary: the components are registered, namespaced, enabled, and carry the right routing inputs.
 * Run: `npx tsx scripts/smoke-plugins-domain.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "example-plugins");
const DATA = await mkdtemp(join(tmpdir(), "leash-domain-"));
process.env["LEASH_DATA_DIR"] = DATA;

const { installStagedPlugin, setPluginEnabled, listPlugins, pluginMcpServers } = await import("@mycelium/leash-core/plugins-store");
const { listSkills } = await import("@mycelium/leash-core/skills-store");
const { listAgents } = await import("@mycelium/leash-core/agents-store");

let failures = 0;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

// ── Install both real plugins (folder source) → quarantine → enable ────────────
const law = await installStagedPlugin(join(EXAMPLES, "law-pack"), { kind: "folder", ref: "law-pack" });
const med = await installStagedPlugin(join(EXAMPLES, "medicine-pack"), { kind: "folder", ref: "medicine-pack" });
check("law installs (id law-assistant), quarantined disabled", law.id === "law-assistant" && !law.enabled);
check("medicine installs (id medicine-assistant), quarantined disabled", med.id === "medicine-assistant" && !med.enabled);
check("medicine inventory: 1 skill + 1 agent + 1 mcp", med.components.skills.length === 1 && med.components.agents.length === 1 && med.components.mcpServers.length === 1);
await setPluginEnabled("law-assistant", true);
await setPluginEnabled("medicine-assistant", true);
check("two plugins registered", (await listPlugins()).length === 2);

// ── Skills surface namespaced + enabled, WITH the routing metadata the matcher uses ──
const skills = await listSkills();
const contract = skills.find((s) => s.slug === "law-assistant:contract-review");
const triage = skills.find((s) => s.slug === "medicine-assistant:symptom-triage");
check("law skill in the catalog, enabled", !!contract && contract.enabled);
check("medicine skill in the catalog, enabled", !!triage && triage.enabled);
// These are EXACTLY the fields activeSkillsSection's lexical+semantic matcher scores against:
check("law skill carries when_to_use triggers (routing input)", (contract?.whenToUse ?? "").toLowerCase().includes("review this contract"));
check("law skill carries examples (routing input)", (contract?.examples ?? []).some((e) => /nda/i.test(e)));
check("medicine skill carries examples incl. the dose phrasing", (triage?.examples ?? []).some((e) => /ibuprofen/i.test(e)));
check("law skill body loaded via the plugin dispatcher", (contract?.body ?? "").includes("careful contracts reviewer"));

// ── Agents become callable sub-agent tools (the chat route maps slug → agent__<plugin>__<name>) ──
const agents = await listAgents();
const agentKey = (slug: string): string => `agent__${slug.replace(/:/g, "__")}`; // mirrors agent-runner.agentToolKey
check("law agent present (→ tool agent__law-assistant__clause-drafter)", agents.some((a) => a.slug === "law-assistant:clause-drafter") && agentKey("law-assistant:clause-drafter") === "agent__law-assistant__clause-drafter");
check("medicine agent present, parsed (tools/max-turns)", agents.some((a) => a.slug === "medicine-assistant:interaction-checker" && a.maxTurns === 4));

// ── MCP server surfaces into the reconcile feed, with ${CLAUDE_PLUGIN_ROOT} expanded ──
const mcp = await pluginMcpServers();
const drugMcp = mcp.find((m) => m.id === "plugin:medicine-assistant:drug-reference");
check("medicine MCP server surfaces (stdio), enabled", !!drugMcp && drugMcp.enabled && drugMcp.transport === "stdio");
check("MCP ${CLAUDE_PLUGIN_ROOT} expanded to the real bundled server path", !!drugMcp?.args?.[0]?.includes("medicine-assistant/server/drug-reference.mjs") && !drugMcp.args[0].includes("CLAUDE_PLUGIN_ROOT"));

// ── Per-plugin isolation: disabling law removes ONLY law ───────────────────────
await setPluginEnabled("law-assistant", false);
const after = await listSkills();
check("disabled law: its skill no longer enabled", !after.some((s) => s.slug === "law-assistant:contract-review" && s.enabled));
check("disabled law: medicine untouched, still enabled", after.some((s) => s.slug === "medicine-assistant:symptom-triage" && s.enabled));
check("disabled law: its agent no longer in the ENABLED set", !(await listAgents()).filter((a) => a.enabled).some((a) => a.slug.startsWith("law-assistant")));

await rm(DATA, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS ✅ (harness wiring proven; activation-decision + inference need the live serve)" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
