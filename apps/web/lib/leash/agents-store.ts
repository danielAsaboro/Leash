/**
 * Web shim for the shared agents store. The parser and persistence live in
 * `@mycelium/leash-core`; built-in agent prompt bodies resolve here so source
 * prompt text stays in `prompt.ts`, not copied markdown.
 */
import "server-only";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgent as coreGetAgent,
  getUserAgent as coreGetUserAgent,
  listAgents as coreListAgents,
} from "@mycelium/leash-core/agents-store";
import type { Agent as CoreAgent } from "@mycelium/leash-core/agents-store";
import { parseToolList, splitFrontmatter } from "@mycelium/leash-core/frontmatter";
import { resolveBuiltinAgentPrompt } from "./prompt.ts";

export * from "@mycelium/leash-core/agents-store";
export {
  deleteAgent,
  saveAgent,
} from "@mycelium/leash-core/agents-store";
export type { Agent } from "@mycelium/leash-core/agents-store";

const here = dirname(fileURLToPath(import.meta.url));
const BUILTIN_AGENTS_DIR = process.env["LEASH_BUILTIN_AGENTS_DIR"] ?? join(here, "..", "..", "builtin-agents");

function parseMaxTurns(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function sourceBuiltinAgent(agent: CoreAgent): Partial<CoreAgent> {
  try {
    const parsed = splitFrontmatter(readFileSync(join(BUILTIN_AGENTS_DIR, `${agent.slug}.md`), "utf8"));
    if (!parsed) return {};
    const fields = parsed.fields;
    return {
      name: fields["name"]?.trim() || agent.name,
      description: fields["description"]?.trim() || agent.description,
      body: resolveBuiltinAgentPrompt(agent.slug, parsed.body || agent.body),
      model: fields["model"]?.trim() ?? agent.model,
      tools: parseToolList(fields["tools"]),
      disallowedTools: parseToolList(fields["disallowed-tools"]),
      skills: parseToolList(fields["skills"]),
      maxTurns: parseMaxTurns(fields["max-turns"], agent.maxTurns),
      builtin: fields["builtin"] === "true" || agent.builtin,
    };
  } catch {
    return {};
  }
}

function withCentralBuiltinPrompt<T extends CoreAgent | null>(agent: T): T {
  if (!agent || !agent.builtin || agent.source !== "user") return agent;
  return { ...agent, ...sourceBuiltinAgent(agent), enabled: agent.enabled } as T;
}

export async function listAgents(): Promise<CoreAgent[]> {
  return (await coreListAgents()).map((agent) => withCentralBuiltinPrompt(agent));
}

export async function getAgent(slug: string): Promise<CoreAgent | null> {
  return withCentralBuiltinPrompt(await coreGetAgent(slug));
}

export async function getUserAgent(slug: string): Promise<CoreAgent | null> {
  return withCentralBuiltinPrompt(await coreGetUserAgent(slug));
}
