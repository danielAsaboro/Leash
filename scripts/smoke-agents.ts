/**
 * Offline smoke for first-class subagents (no serve needed) — proves the user-level agents store and
 * that it surfaces together with plugin agents (the skills pattern: user ∪ plugin). Run:
 * `npx tsx scripts/smoke-agents.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "example-plugins");
const DATA = await mkdtemp(join(tmpdir(), "leash-agents-"));
process.env["LEASH_DATA_DIR"] = DATA;

const { saveAgent, listAgents, listUserAgents, getAgent, getUserAgent, deleteAgent } = await import("@mycelium/leash-core/agents-store");
const { installStagedPlugin, setPluginEnabled } = await import("@mycelium/leash-core/plugins-store");

let failures = 0;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

// ── Create a USER subagent ──────────────────────────────────────────────────────
const created = await saveAgent({
  name: "Test Reviewer",
  description: "Reviews code for issues",
  body: "You are a careful reviewer.",
  model: "chat",
  tools: ["bash"],
  disallowedTools: ["run_command"],
  skills: ["contract-review", "law-assistant:contract-review"],
  maxTurns: 5,
  enabled: true,
});
check("saveAgent returns the agent (slug test-reviewer, source user)", created.slug === "test-reviewer" && created.source === "user");
const fromStore = await getUserAgent("test-reviewer");
check("user agent reads back with parsed fields", !!fromStore && fromStore.tools.includes("bash") && fromStore.disallowedTools.includes("run_command") && fromStore.maxTurns === 5 && fromStore.enabled);
check("skills-to-preload parsed (incl. namespaced plugin slug)", !!fromStore && fromStore.skills.includes("contract-review") && fromStore.skills.includes("law-assistant:contract-review"));
check("getAgent dispatches to the user store", (await getAgent("test-reviewer"))?.source === "user");
check("listUserAgents has exactly the one", (await listUserAgents()).length === 1);

// ── Install a plugin that ships an agent → both sources surface together ─────────
const med = await installStagedPlugin(join(EXAMPLES, "medicine-pack"), { kind: "folder", ref: "medicine-pack" });
await setPluginEnabled(med.id, true);
const all = await listAgents();
check("listAgents() = user ∪ plugin agents", all.some((a) => a.slug === "test-reviewer" && a.source === "user") && all.some((a) => a.slug === "medicine-assistant:interaction-checker" && a.source === "plugin"));
check("getAgent dispatches to the plugin surfacer for a namespaced slug", (await getAgent("medicine-assistant:interaction-checker"))?.source === "plugin");

// ── Per-agent enable/quarantine (user) ──────────────────────────────────────────
await saveAgent({ slug: "test-reviewer", name: "Test Reviewer", description: "Reviews code for issues", body: "You are a careful reviewer.", enabled: false });
check("disabled user agent still listed but enabled=false", (await listAgents()).some((a) => a.slug === "test-reviewer" && !a.enabled));
check("enabled filter (what the chat route applies) drops it", !(await listAgents()).filter((a) => a.enabled).some((a) => a.slug === "test-reviewer"));

// ── Delete ──────────────────────────────────────────────────────────────────────
await deleteAgent("test-reviewer");
check("deleteAgent removes the user agent", !(await listAgents()).some((a) => a.slug === "test-reviewer"));
check("plugin agent untouched by the user-agent delete", (await listAgents()).some((a) => a.slug === "medicine-assistant:interaction-checker"));

await rm(DATA, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
