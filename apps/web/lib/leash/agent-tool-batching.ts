const MULTI_READ_INTENT_RE =
  /\b(?:all|both|each|compare|cross-check|crosscheck|together|in parallel|independent|simultaneously)\b/i;
const ORDERED_FLOW_RE = /\b(?:first|then|after|before|next|followed by|using (?:its|the) (?:result|output))\b/i;

export type InitialToolPolicy = "auto" | "none" | "required" | { type: "tool"; toolName: string };

const TOOL_EVIDENCE_INTENT_RE =
  /\b(?:search|find|look\s*up|retrieve|read|inspect|check|verify|list|current|latest|today|screen|context|memory|note|file|task|record|evidence|quote|source|research|run|execute|calculate)\b/i;

type CompletedAgentStep = {
  toolCalls?: ReadonlyArray<{ toolName?: string; input?: unknown; args?: unknown }>;
  toolResults?: ReadonlyArray<{ output?: unknown }>;
};

function structuredToolError(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { isError?: unknown }).isError === true;
}

/** Stop an autonomous delegate from paying for the same failed or duplicate tool call repeatedly. */
export function shouldForceSubagentSynthesis(steps: ReadonlyArray<CompletedAgentStep>): boolean {
  if (steps.some((step) => (step.toolResults ?? []).some((result) => structuredToolError(result.output)))) return true;

  const seen = new Set<string>();
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      const signature = JSON.stringify([call.toolName ?? "", call.input ?? call.args ?? null]);
      if (seen.has(signature)) return true;
      seen.add(signature);
    }
  }
  return false;
}

function normalizedWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function containsWordsInOrder(text: string, phrase: string): boolean {
  const words = text.split(/\s+/);
  let cursor = 0;
  for (const expected of phrase.split(/\s+/)) {
    const found = words.indexOf(expected, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

function mentionedTools(task: string, toolNames: string[]): string[] {
  const normalizedTask = normalizedWords(task);
  return toolNames.filter((name) => containsWordsInOrder(normalizedTask, normalizedWords(name)));
}

/**
 * Select the first-step tool policy from the task's data-flow language.
 *
 * An explicitly named first operation is pinned so a dependent call cannot be
 * speculated into the same batch. Independent multi-read work requires a tool
 * step but leaves call selection to the model so it can issue a parallel batch.
 */
export function initialToolPolicyForTask(task: string, toolNames: string[]): InitialToolPolicy {
  if (!toolNames.length) return "auto";

  const normalizedTask = normalizedWords(task);
  const first = normalizedTask.search(/\bfirst\b/);
  const then = first >= 0 ? normalizedTask.indexOf(" then ", first) : -1;
  const firstClause = first >= 0
    ? normalizedTask.slice(first, then >= 0 ? then : Math.min(normalizedTask.length, first + 120))
    : "";
  if (firstClause) {
    const explicitlyFirst = toolNames.find((name) => containsWordsInOrder(firstClause, normalizedWords(name)));
    if (explicitlyFirst) return { type: "tool", toolName: explicitlyFirst };
  }

  // Natural delegated tasks commonly say "use search_graph and active_context"
  // without the literal words "both" or "in parallel". Two explicitly named
  // tools with no ordering language form an independent batch.
  if (!ORDERED_FLOW_RE.test(task) && mentionedTools(task, toolNames).length >= 2) return "required";

  if (MULTI_READ_INTENT_RE.test(task)) return "required";
  return TOOL_EVIDENCE_INTENT_RE.test(task) ? "auto" : "none";
}

/**
 * Tool schemas actually exposed to a delegated task. QVAC models may emit calls
 * even with `toolChoice: "none"`, so reasoning-only work must receive zero schemas.
 */
export function toolNamesForTask(task: string, toolNames: string[]): string[] {
  return initialToolPolicyForTask(task, toolNames) === "none" ? [] : toolNames;
}

/** Concrete batching instruction for tools explicitly named in an independent task. */
export function initialToolBatchInstruction(task: string, toolNames: string[]): string {
  if (initialToolPolicyForTask(task, toolNames) !== "required") return "";
  const mentioned = mentionedTools(task, toolNames);
  if (mentioned.length < 2) return "";
  return `In your first response, call ${mentioned.join(", ")} together in one tool-call step. They are independent; do not call them one at a time.`;
}

/** Independent batches become synthesis-only after their first tool step. */
export function toolPolicyForStep(initial: InitialToolPolicy, stepNumber: number): InitialToolPolicy | "none" {
  if (stepNumber === 0) return initial;
  return initial === "required" ? "none" : "auto";
}

/**
 * Require an initial tool step only when the delegated task clearly asks for
 * a multi-source operation. Pure reasoning stays tool-free; evidence work keeps
 * automatic selection; later independent-batch steps become synthesis-only.
 */
export function shouldRequireInitialToolBatch(task: string, toolNames: string[]): boolean {
  // One tool may still need several independent calls with different inputs
  // (for example, reading three records by id), so capability count is not a
  // proxy for call count.
  return initialToolPolicyForTask(task, toolNames) === "required";
}
