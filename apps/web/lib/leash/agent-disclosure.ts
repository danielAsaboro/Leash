import type { Agent } from "./agents-store.ts";
import { agentToolKey } from "./agent-keys.ts";

export type AgentDisclosureMode = "none" | "explicit" | "semantic";

export interface DisclosedAgent {
  slug: string;
  name: string;
  toolName: string;
  reason: "explicit" | "semantic";
}

export interface AgentDisclosure {
  mode: AgentDisclosureMode;
  selected: DisclosedAgent[];
  suppressRunSkill: boolean;
  directDelegate: boolean;
}

export interface AgentDisclosureOptions {
  activeSkillTools?: string[];
}

const NONE: AgentDisclosure = { mode: "none", selected: [], suppressRunSkill: false, directDelegate: false };
const MAX_EXPLICIT_AGENTS = 2;

const BUILTIN_ALIASES: Record<string, string[]> = {
  coder: ["grace", "coder", "coding specialist"],
  summarizer: ["bree", "summarizer", "summary specialist"],
  researcher: ["ruth", "researcher", "research specialist"],
  health: ["joy", "health specialist", "wellbeing specialist"],
};

const CAPABILITY_ALIASES: Record<string, string[]> = {
  coder: ["code", "coding", "debug", "debugging", "bug", "stack trace", "typescript", "javascript", "script", "test", "implementation"],
  summarizer: ["summarize", "summary", "gist", "condense", "transcript", "notes", "thread", "document", "paper"],
  researcher: ["research", "sources", "citations", "compare sources", "investigate", "deep dive", "evidence", "literature"],
  health: ["health", "medical", "symptom", "medication", "therapy", "sleep", "nutrition", "diagnosis", "treatment"],
};

const SEMANTIC_KEYWORDS: Record<string, string[]> = {
  coder: ["code", "coding", "debug", "bug", "stack trace", "typescript", "javascript", "function", "route", "test", "implement", "compile", "error", "fix"],
  summarizer: ["summarize", "summary", "gist", "condense", "transcript", "notes", "document", "thread", "action items", "key points"],
  researcher: ["research", "sources", "citations", "compare", "investigate", "evidence", "paper", "literature", "findings"],
  health: ["health", "medical", "symptom", "medication", "sleep", "nutrition", "therapy", "diagnosis", "treatment", "emergency"],
};

const DELEGATION_RE = /\b(?:ask|delegate|use|hand\s*off|send\s+(?:it|this|that)?\s*to|route\s+to|give\s+(?:it|this|that)?\s*to|subagent|specialist)\b/i;
const SKILL_RE = /\b(?:skill|run_skill|read_skill)\b/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function words(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

function hasPhrase(text: string, phrase: string): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  if (p.includes(" ")) return text.includes(p);
  return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function aliasesFor(agent: Agent): string[] {
  const aliases = new Set<string>([agent.slug, agent.name, ...words(agent.slug), ...words(agent.name)]);
  for (const a of BUILTIN_ALIASES[agent.slug] ?? []) aliases.add(a);
  return [...aliases].filter(Boolean);
}

function capabilityAliasesFor(agent: Agent): string[] {
  const aliases = new Set<string>(CAPABILITY_ALIASES[agent.slug] ?? []);
  for (const w of words(agent.description)) aliases.add(w);
  return [...aliases].filter(Boolean);
}

function explicitMatches(text: string, agents: Agent[]): Agent[] {
  const delegationIntent = DELEGATION_RE.test(text);
  const out: Agent[] = [];
  for (const agent of agents) {
    const named = aliasesFor(agent).some((a) => hasPhrase(text, a));
    const capabilityNamed = delegationIntent && capabilityAliasesFor(agent).some((a) => hasPhrase(text, a));
    if (named || capabilityNamed) out.push(agent);
    if (out.length >= MAX_EXPLICIT_AGENTS) break;
  }
  return out;
}

function semanticScore(text: string, agent: Agent): number {
  const keywords = SEMANTIC_KEYWORDS[agent.slug] ?? words(agent.description);
  return keywords.reduce((score, keyword) => score + (hasPhrase(text, keyword) ? 1 : 0), 0);
}

function semanticMatch(text: string, agents: Agent[]): Agent | null {
  const scored = agents
    .map((agent) => ({ agent, score: semanticScore(text, agent) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < 2) return null;
  const runnerUp = scored[1]?.score ?? 0;
  if (top.score - runnerUp < 1) return null;
  return top.agent;
}

function selected(agent: Agent, reason: "explicit" | "semantic"): DisclosedAgent {
  return { slug: agent.slug, name: agent.name, toolName: agentToolKey(agent.slug), reason };
}

export function planAgentDisclosure(text: string, agents: Agent[], options: AgentDisclosureOptions = {}): AgentDisclosure {
  const normalized = normalize(text);
  if (!normalized) return NONE;
  const enabled = agents.filter((a) => a.enabled);
  if (!enabled.length) return NONE;

  const explicit = explicitMatches(normalized, enabled);
  if (explicit.length && !SKILL_RE.test(normalized)) {
    return {
      mode: "explicit",
      selected: explicit.map((agent) => selected(agent, "explicit")),
      suppressRunSkill: true,
      directDelegate: false,
    };
  }

  if ((options.activeSkillTools ?? []).length > 0) return NONE;

  const semantic = semanticMatch(normalized, enabled);
  if (!semantic) return NONE;
  return {
    mode: "semantic",
    selected: [selected(semantic, "semantic")],
    suppressRunSkill: true,
    directDelegate: false,
  };
}
