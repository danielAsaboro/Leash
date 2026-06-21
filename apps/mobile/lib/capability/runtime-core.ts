import type { ToolSet } from "ai";

import {
  buildCapabilityInventory,
  type CapabilityAgent,
  type CapabilityInventory,
  type CapabilityPlugin,
  type CapabilitySkill,
  type CapabilityToolDescriptor,
  type CapabilityToolState,
} from "../../../../packages/capability-runtime/src/index";
import { buildMobileSkillSystemAddon } from "../../prompt";
import { selectSkill } from "../agent/skill-selection";

export interface MobileCapabilitySnapshot {
  inventory: CapabilityInventory;
  localTools: ToolSet;
  mcpTools: ToolSet;
}

export interface BuildMobileCapabilitySnapshotInput {
  skills: CapabilitySkill[];
  agents: CapabilityAgent[];
  plugins: CapabilityPlugin[];
  mcpServers: CapabilityInventory["mcpServers"];
  toolCatalog: CapabilityToolDescriptor[];
  toolState?: CapabilityToolState;
  localTools: ToolSet;
  mcpTools: ToolSet;
}

export interface MobileCapabilityTurn {
  system: string;
  tools: ToolSet;
  skill: CapabilitySkill | null;
  agent: CapabilityAgent | null;
}

const MAIN_AGENT_NAMES = new Set(["leash"]);
const AGENT_K = 60;
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "help", "i", "if", "in", "into", "is", "it", "me", "my", "of", "on", "or", "please", "the", "this", "to", "with", "you",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter((token) => !STOP.has(token));
}

function lexicalScore(query: string, agent: CapabilityAgent): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const targetTokens = new Set(tokenize(`${agent.name} ${agent.description} ${agent.slug}`));
  let hits = 0;
  for (const token of queryTokens) if (targetTokens.has(token)) hits += 1;
  const coverage = hits / queryTokens.size;
  const precision = hits / Math.max(targetTokens.size, 1);
  return coverage * 0.75 + precision * 0.25;
}

function rankAgents(query: string, agents: CapabilityAgent[]): CapabilityAgent | null {
  const enabled = agents.filter((agent) => agent.enabled && !MAIN_AGENT_NAMES.has(agent.slug.toLowerCase()) && !MAIN_AGENT_NAMES.has(agent.name.toLowerCase()));
  if (enabled.length === 0) return null;
  const lower = query.toLowerCase();
  const explicit = enabled.find((agent) => lower.includes(agent.slug.toLowerCase()) || lower.includes(agent.name.toLowerCase()));
  if (explicit) return explicit;

  const scored = enabled
    .map((agent) => ({ agent, score: lexicalScore(query, agent) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));

  if (scored.length === 0) return null;
  const ranks = new Map(scored.map((entry, index) => [entry.agent.slug, index + 1]));
  const best = scored
    .map((entry) => ({ agent: entry.agent, score: 1 / (AGENT_K + (ranks.get(entry.agent.slug) ?? scored.length)) }))
    .sort((a, b) => b.score - a.score)[0];
  return best?.agent ?? null;
}

function mergedToolSet(snapshot: MobileCapabilitySnapshot): ToolSet {
  return { ...snapshot.localTools, ...snapshot.mcpTools };
}

function wrapAskFirst(toolName: string, tool: ToolSet[string]): ToolSet[string] {
  const typed = tool as ToolSet[string] & { execute?: (input: unknown, opts: unknown) => Promise<unknown> };
  if (!typed.execute) return tool;
  return {
    ...typed,
    execute: async () => {
      throw new Error(`"${toolName}" requires approval in Brain → Tools before mobile can run it.`);
    },
  };
}

function applyToolFilters(snapshot: MobileCapabilitySnapshot, skill: CapabilitySkill | null, agent: CapabilityAgent | null): ToolSet {
  const rows = snapshot.inventory.tools;
  const all = mergedToolSet(snapshot);
  const enabledNames = new Set(rows.filter((row) => row.enabled).map((row) => row.name));
  let names = Object.keys(all).filter((name) => enabledNames.has(name));

  if (agent?.tools.length) names = names.filter((name) => agent.tools.includes(name));
  if (agent?.disallowedTools.length) names = names.filter((name) => !agent.disallowedTools.includes(name));
  if (skill?.tools.length) names = names.filter((name) => skill.tools.includes(name));

  const askFirst = new Set(rows.filter((row) => row.askFirst).map((row) => row.name));
  return Object.fromEntries(
    names.map((name) => {
      const tool = all[name] as ToolSet[string];
      return [name, askFirst.has(name) ? wrapAskFirst(name, tool) : tool];
    }),
  );
}

function agentSystemAddon(agent: CapabilityAgent): string {
  return `\n\nSpecialist agent: ${agent.name}\nPriority: answer this turn in ${agent.name}'s specialty when it helps.\n${agent.body}`;
}

export function buildMobileCapabilitySnapshot(input: BuildMobileCapabilitySnapshotInput): MobileCapabilitySnapshot {
  return {
    inventory: buildCapabilityInventory({
      skills: input.skills,
      agents: input.agents,
      plugins: input.plugins,
      mcpServers: input.mcpServers,
      toolCatalog: input.toolCatalog,
      toolState: input.toolState,
    }),
    localTools: input.localTools,
    mcpTools: input.mcpTools,
  };
}

export async function resolveMobileCapabilityTurn(
  snapshot: MobileCapabilitySnapshot,
  input: { query: string; baseSystem: string },
): Promise<MobileCapabilityTurn> {
  const enabledSkills = snapshot.inventory.skills.filter((skill) => skill.enabled && !skill.disableModelInvocation);
  const skillMatch = await selectSkill(
    input.query,
    enabledSkills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      examples: skill.examples,
      whenToUse: skill.whenToUse,
    })),
  );
  const skill = skillMatch ? enabledSkills.find((entry) => entry.slug === skillMatch.skill.slug) ?? null : null;
  const agent = rankAgents(input.query, snapshot.inventory.agents);

  const additions = [skill ? buildMobileSkillSystemAddon({ name: skill.name, body: skill.body }) : "", agent ? agentSystemAddon(agent) : ""]
    .filter(Boolean)
    .join("");

  return {
    system: `${input.baseSystem}${additions}`,
    tools: applyToolFilters(snapshot, skill, agent),
    skill,
    agent,
  };
}
