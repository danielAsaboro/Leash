import * as FileSystem from "expo-file-system/legacy";

import { validateMobileMcpServerInput, type CapabilityAgent, type CapabilityPlugin, type CapabilitySkill, type CapabilityToolState, type McpServerEntry } from "../../../../packages/capability-runtime/src/index";
import { listMeshSkills, type MeshSkill } from "../../meshClient";
import { MOBILE_BUILTIN_AGENTS, MOBILE_BUILTIN_SKILLS } from "./builtins";

const DIR = `${FileSystem.documentDirectory}capability-runtime/`;
const SKILLS_FILE = `${DIR}skills.json`;
const SKILLS_STATE_FILE = `${DIR}skills-state.json`;
const AGENTS_FILE = `${DIR}agents.json`;
const AGENTS_STATE_FILE = `${DIR}agents-state.json`;
const PLUGINS_FILE = `${DIR}plugins.json`;
const MCP_FILE = `${DIR}mcp.json`;
const TOOLS_FILE = `${DIR}tools.json`;

type DisabledState = { disabled?: string[] };
type StoredMcpConfig = { servers?: McpServerEntry[] };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return fallback;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(file)) as unknown;
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(file, JSON.stringify(value));
}

function applyDisabled<T extends { slug: string; enabled: boolean }>(items: T[], disabled: Set<string>): T[] {
  return items.map((item) => ({ ...item, enabled: item.enabled && !disabled.has(item.slug) }));
}

async function readDisabled(file: string): Promise<Set<string>> {
  const state = await readJson<DisabledState>(file, {});
  return new Set((state.disabled ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0));
}

async function setDisabled(file: string, slug: string, enabled: boolean): Promise<void> {
  const disabled = await readDisabled(file);
  if (enabled) disabled.delete(slug);
  else disabled.add(slug);
  await writeJson(file, { disabled: [...disabled].sort() });
}

function builtinSkillMap(): Map<string, CapabilitySkill> {
  return new Map(MOBILE_BUILTIN_SKILLS.map((skill) => [skill.slug, skill]));
}

function builtinAgentMap(): Map<string, CapabilityAgent> {
  return new Map(MOBILE_BUILTIN_AGENTS.map((agent) => [agent.slug, agent]));
}

export async function listCapabilitySkills(): Promise<CapabilitySkill[]> {
  const stored = await readJson<CapabilitySkill[]>(SKILLS_FILE, []);
  const merged = builtinSkillMap();
  for (const skill of stored) merged.set(skill.slug, { ...skill, source: "local", pluginId: "" });
  return applyDisabled([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), await readDisabled(SKILLS_STATE_FILE));
}

export async function saveCapabilitySkill(input: {
  slug?: string;
  name: string;
  description: string;
  body: string;
  tools?: string[];
  steps?: string[];
  examples?: string[];
  whenToUse?: string;
}): Promise<CapabilitySkill> {
  const stored = await readJson<CapabilitySkill[]>(SKILLS_FILE, []);
  const slug = input.slug?.trim() || slugify(input.name);
  const next: CapabilitySkill = {
    slug,
    name: input.name.trim(),
    description: input.description.trim(),
    enabled: true,
    body: input.body.trim(),
    tools: input.tools ?? [],
    steps: input.steps ?? [],
    examples: input.examples ?? [],
    whenToUse: input.whenToUse ?? "",
    builtin: false,
    userInvocable: true,
    disableModelInvocation: false,
    files: [],
    extras: {},
    source: "local",
    pluginId: "",
  };
  const merged = [...stored.filter((skill) => skill.slug !== slug), next].sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(SKILLS_FILE, merged);
  await setCapabilitySkillEnabled(slug, true);
  return next;
}

export async function deleteCapabilitySkill(slug: string): Promise<void> {
  const builtin = builtinSkillMap().has(slug);
  if (builtin) return;
  const stored = await readJson<CapabilitySkill[]>(SKILLS_FILE, []);
  await writeJson(SKILLS_FILE, stored.filter((skill) => skill.slug !== slug));
}

export async function setCapabilitySkillEnabled(slug: string, enabled: boolean): Promise<void> {
  await setDisabled(SKILLS_STATE_FILE, slug, enabled);
}

function meshSkillToCapability(skill: MeshSkill): CapabilitySkill {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    enabled: true,
    body: skill.body,
    tools: [],
    steps: [],
    examples: skill.examples ?? [],
    whenToUse: skill.whenToUse ?? "",
    builtin: false,
    userInvocable: true,
    disableModelInvocation: false,
    files: [],
    extras: { importedFrom: "mesh" },
    source: "local",
    pluginId: "",
  };
}

export async function syncCapabilitySkillsFromMesh(): Promise<number> {
  try {
    const incoming = await listMeshSkills();
    if (incoming.length === 0) return 0;
    const stored = await readJson<CapabilitySkill[]>(SKILLS_FILE, []);
    const bySlug = new Map(stored.map((skill) => [skill.slug, skill]));
    for (const skill of incoming) bySlug.set(skill.slug, meshSkillToCapability(skill));
    await writeJson(SKILLS_FILE, [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name)));
    return incoming.length;
  } catch {
    return 0;
  }
}

export async function listCapabilityAgents(): Promise<CapabilityAgent[]> {
  const stored = await readJson<CapabilityAgent[]>(AGENTS_FILE, []);
  const merged = builtinAgentMap();
  for (const agent of stored) merged.set(agent.slug, { ...agent, source: "local", pluginId: "" });
  return applyDisabled([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), await readDisabled(AGENTS_STATE_FILE));
}

export async function saveCapabilityAgent(input: Omit<CapabilityAgent, "source" | "pluginId"> & { slug?: string }): Promise<CapabilityAgent> {
  const stored = await readJson<CapabilityAgent[]>(AGENTS_FILE, []);
  const slug = input.slug?.trim() || slugify(input.name);
  const next: CapabilityAgent = {
    ...input,
    slug,
    source: "local",
    pluginId: "",
    name: input.name.trim(),
    description: input.description.trim(),
    body: input.body.trim(),
    enabled: true,
  };
  const merged = [...stored.filter((agent) => agent.slug !== slug), next].sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(AGENTS_FILE, merged);
  await setCapabilityAgentEnabled(slug, true);
  return next;
}

export async function deleteCapabilityAgent(slug: string): Promise<void> {
  if (builtinAgentMap().has(slug)) return;
  const stored = await readJson<CapabilityAgent[]>(AGENTS_FILE, []);
  await writeJson(AGENTS_FILE, stored.filter((agent) => agent.slug !== slug));
}

export async function setCapabilityAgentEnabled(slug: string, enabled: boolean): Promise<void> {
  await setDisabled(AGENTS_STATE_FILE, slug, enabled);
}

export async function listCapabilityPlugins(): Promise<CapabilityPlugin[]> {
  return (await readJson<CapabilityPlugin[]>(PLUGINS_FILE, [])).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveCapabilityPlugin(plugin: CapabilityPlugin): Promise<void> {
  const plugins = await readJson<CapabilityPlugin[]>(PLUGINS_FILE, []);
  const next = [...plugins.filter((entry) => entry.id !== plugin.id), plugin].sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(PLUGINS_FILE, next);
}

export async function setCapabilityPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const plugins = await readJson<CapabilityPlugin[]>(PLUGINS_FILE, []);
  await writeJson(
    PLUGINS_FILE,
    plugins.map((plugin) => (plugin.id === id ? { ...plugin, enabled } : plugin)),
  );
}

export async function listCapabilityMcpServers(): Promise<McpServerEntry[]> {
  const config = await readJson<StoredMcpConfig>(MCP_FILE, {});
  return (config.servers ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveCapabilityMcpServer(input: Omit<McpServerEntry, "id"> & { id?: string }): Promise<McpServerEntry> {
  const validated = validateMobileMcpServerInput(input);
  const servers = await listCapabilityMcpServers();
  const id = input.id?.trim() || slugify(validated.name);
  const next: McpServerEntry = { ...validated, id, enabled: input.enabled ?? true };
  await writeJson(MCP_FILE, { servers: [...servers.filter((server) => server.id !== id), next] });
  return next;
}

export async function removeCapabilityMcpServer(id: string): Promise<void> {
  const servers = await listCapabilityMcpServers();
  await writeJson(MCP_FILE, { servers: servers.filter((server) => server.id !== id) });
}

export async function setCapabilityMcpEnabled(id: string, enabled: boolean): Promise<void> {
  const servers = await listCapabilityMcpServers();
  await writeJson(MCP_FILE, { servers: servers.map((server) => (server.id === id ? { ...server, enabled } : server)) });
}

export async function readCapabilityToolState(): Promise<CapabilityToolState> {
  return await readJson<CapabilityToolState>(TOOLS_FILE, { disabled: [], askFirst: {} });
}

export async function setCapabilityToolEnabled(name: string, enabled: boolean): Promise<void> {
  const state = await readCapabilityToolState();
  const disabled = new Set(state.disabled ?? []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  await writeJson(TOOLS_FILE, { ...state, disabled: [...disabled].sort() });
}

export async function setCapabilityToolAskFirst(name: string, askFirst: boolean): Promise<void> {
  const state = await readCapabilityToolState();
  const next = { ...(state.askFirst ?? {}), [name]: askFirst };
  await writeJson(TOOLS_FILE, { ...state, askFirst: next });
}
