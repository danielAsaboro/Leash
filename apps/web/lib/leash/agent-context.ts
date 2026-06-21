export interface AgentDelegateContextAgent {
  slug: string;
  name: string;
  description?: string;
}

export interface AgentDelegateContextInput {
  agent?: AgentDelegateContextAgent;
  task?: string;
  parentContextCapsule?: string;
  summarySection?: string;
  currentUserTurn?: string;
  selectedTools?: string[];
  memoryContext?: string;
  maxChars?: number;
}

export interface AgentDelegateContextPacket {
  text: string;
  tokenEstimate: number;
  truncated: boolean;
  includedStepIds: string[];
  artifactIds: string[];
  selectedTools: string[];
}

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function clean(value: string | undefined, max: number): string {
  const s = value ? value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]").replace(/\s+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max - 12) + " [truncated]" : s;
}

function pushBounded(lines: string[], line: string, maxChars: number): boolean {
  const next = [...lines, line].join("\n");
  if (next.length > maxChars) return false;
  lines.push(line);
  return true;
}

function boundedBlock(lines: string[], title: string, body: string | undefined, maxChars: number, maxBodyChars: number): boolean {
  const text = clean(body, maxBodyChars);
  if (!text) return true;
  return pushBounded(lines, `${title}\n${text}`, maxChars);
}

export function buildAgentDelegateContextPacket(input: AgentDelegateContextInput): AgentDelegateContextPacket {
  const maxChars = Math.max(400, input.maxChars ?? 5000);
  const lines: string[] = [];
  let truncated = false;
  let includedStepIds: string[] = [];
  let artifactIds: string[] = [];

  if (input.agent) {
    const desc = clean(input.agent.description, 240);
    const agentLine = desc ? `Agent: ${clean(input.agent.name, 120)} (${clean(input.agent.slug, 120)}) — ${desc}` : `Agent: ${clean(input.agent.name, 120)} (${clean(input.agent.slug, 120)})`;
    truncated = !pushBounded(lines, agentLine, maxChars) || truncated;
  }

  truncated = !boundedBlock(lines, "Delegated task:", input.task, maxChars, 900) || truncated;

  truncated = !boundedBlock(lines, "Parent run capsule:", input.parentContextCapsule, maxChars, 3600) || truncated;

  truncated = !boundedBlock(lines, "Compacted conversation summary:", input.summarySection, maxChars, 1800) || truncated;
  truncated = !boundedBlock(lines, "Latest user turn:", input.currentUserTurn, maxChars, 1200) || truncated;
  truncated = !boundedBlock(lines, "Agent memory digest:", input.memoryContext, maxChars, 1200) || truncated;

  const selectedTools = [...new Set(input.selectedTools ?? [])].sort();
  if (input.selectedTools !== undefined) {
    truncated = !pushBounded(lines, `Selected subagent tools: ${selectedTools.length ? selectedTools.map((t) => clean(t, 120)).join(", ") : "none"}`, maxChars) || truncated;
  }

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 12).trimEnd() + " [truncated]";
    truncated = true;
  }

  return {
    text,
    tokenEstimate: tokenEstimate(text),
    truncated,
    includedStepIds,
    artifactIds,
    selectedTools,
  };
}
