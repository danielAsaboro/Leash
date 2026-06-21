import type { ToolSet } from "ai";
import { toolPolicy } from "@mycelium/leash-core/tool-policy";
import type { DisclosedAgent } from "./agent-disclosure.ts";

export interface ExplicitAgentTask {
  slug: string;
  name: string;
  toolName: string;
  task: string;
  mandatedTools: string[];
}

const AFTER_DELEGATES_RE = /\bafter\s+(?:both|all|the\s+(?:agents?|specialists?|delegates?))\s+(?:return|finish|respond|complete)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentStart(text: string, agent: DisclosedAgent): { start: number; bodyStart: number } | null {
  const aliases = [agent.name, agent.slug]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(`\\b(?:delegate|ask|send)\\s+(?:the\\s+)?(?:${aliases})\\b`, "i");
  const match = re.exec(text);
  if (!match || match.index === undefined) return null;
  return { start: match.index, bodyStart: match.index + match[0].length };
}

function cleanTask(value: string): string {
  return value
    .replace(/^\s*(?:\/\s*[a-z][a-z -]*?)?\s*(?:agent|subagent|specialist)?\s*(?:a\s+separate\s+task\s+)?(?:to\s+)?/i, "")
    .replace(/[.;,\s]+$/, "")
    .trim();
}

function mentionedTools(task: string, availableToolNames: string[]): string[] {
  const normalized = task.toLowerCase().replace(/[-_]+/g, " ");
  return availableToolNames.filter((name) => {
    const phrase = name.toLowerCase().replace(/[-_]+/g, " ");
    return new RegExp(`\\b${escapeRegExp(phrase).replace(/\\ /g, "\\s+")}\\b`, "i").test(normalized);
  });
}

/**
 * Parse only explicit, independently addressed delegations. Ambiguous shared
 * tasks deliberately return null so the normal model-planned loop remains the
 * fallback.
 */
export function planExplicitAgentTasks(
  text: string,
  selected: DisclosedAgent[],
  availableToolNames: string[],
): ExplicitAgentTask[] | null {
  if (!text.trim() || selected.length === 0) return null;
  const starts = selected
    .map((agent) => ({ agent, at: agentStart(text, agent) }))
    .filter((entry): entry is { agent: DisclosedAgent; at: { start: number; bodyStart: number } } => entry.at !== null)
    .sort((left, right) => left.at.start - right.at.start);
  if (starts.length !== selected.length) return null;

  const after = AFTER_DELEGATES_RE.exec(text);
  const afterIndex = after?.index ?? text.length;
  const tasks = starts.map((entry, index) => {
    const nextStart = starts[index + 1]?.at.start ?? afterIndex;
    const end = Math.max(entry.at.bodyStart, Math.min(nextStart, afterIndex));
    const task = cleanTask(text.slice(entry.at.bodyStart, end));
    return {
      slug: entry.agent.slug,
      name: entry.agent.name,
      toolName: entry.agent.toolName,
      task,
      mandatedTools: mentionedTools(task, availableToolNames),
    } satisfies ExplicitAgentTask;
  });
  if (tasks.some((entry) => entry.task.length < 20)) return null;
  return tasks;
}

type InputBuilder = (request: string) => Record<string, unknown>;

const READ_INPUT_BUILDERS: Record<string, InputBuilder> = {
  active_context: () => ({}),
  activity_recent: () => ({ minutes: 30 }),
  list_tasks: () => ({}),
  recall: (request) => ({ query: request }),
  search_graph: (request) => ({ query: request, topK: 3 }),
  understory_search: (request) => ({ query: request }),
  understory_today: () => ({}),
};

export interface PlannedReadCall {
  toolName: string;
  input: Record<string, unknown>;
  tool: ToolSet[string];
}

/** Build a real, approval-free read batch or decline the fast path. */
export function planMandatedReadCalls(
  request: string,
  toolNames: string[],
  registry: ToolSet,
): PlannedReadCall[] | null {
  const unique = [...new Set(toolNames)];
  // An explicit specialist request does not need to invent a read just to enter
  // the deterministic delegation path. An empty batch is a valid plan: the
  // specialist can answer from its bounded task/context packet in one decode.
  if (unique.length === 0) return [];
  const calls: PlannedReadCall[] = [];
  for (const toolName of unique) {
    const definition = registry[toolName];
    const policy = toolPolicy(toolName);
    const input = READ_INPUT_BUILDERS[toolName]?.(request);
    if (!definition?.execute || policy.risk !== "read" || policy.approval !== "none" || !input) return null;
    calls.push({ toolName, input, tool: definition });
  }
  return calls;
}
