/**
 * Web shim for the shared agents store. The parser and persistence live in
 * `@mycelium/leash-core`; built-in agent prompt bodies resolve here so source
 * prompt text stays in `prompt.ts`, not copied markdown.
 */
import "server-only";
import {
  getAgent as coreGetAgent,
  getUserAgent as coreGetUserAgent,
  listAgents as coreListAgents,
} from "@mycelium/leash-core/agents-store";
import type { Agent as CoreAgent } from "@mycelium/leash-core/agents-store";
import { resolveBuiltinAgentPrompt } from "./prompt.ts";

export * from "@mycelium/leash-core/agents-store";
export {
  deleteAgent,
  saveAgent,
} from "@mycelium/leash-core/agents-store";
export type { Agent } from "@mycelium/leash-core/agents-store";

function withCentralBuiltinPrompt<T extends CoreAgent | null>(agent: T): T {
  if (!agent || !agent.builtin || agent.source !== "user") return agent;
  return { ...agent, body: resolveBuiltinAgentPrompt(agent.slug, agent.body) } as T;
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
