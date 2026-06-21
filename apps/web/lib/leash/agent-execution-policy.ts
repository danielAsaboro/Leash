export interface SubagentExecutionPolicy {
  reasoning: "none" | "high";
  maxOutputTokens: number;
  temperature: number;
  topP: number;
}

const COMPLEX_WORK_RE =
  /\b(?:implement|modify|write code|debug|fix|refactor|design|architect|security audit|threat model|diagnose|prove|formal|exploit|migration|multi-step calculation)\b/i;
const HIGH_STAKES_RE =
  /\b(?:diagnosis|treatment|medication|legal advice|financial advice|authorize|approve payment|sign transaction|delete|publish|send externally)\b/i;
const EVIDENCE_WORK_RE =
  /\b(?:summari[sz]e|retrieve|extract|list|quote|compare|cross-check|crosscheck|verify|check|classify|threshold|evidence|facts?|key points|gist)\b/i;

/**
 * Allocate inference effort from task semantics instead of forcing every delegate
 * into an expensive reasoning decode. Evidence transforms are bounded and direct;
 * consequential or genuinely constructive work retains deep reasoning.
 */
export function subagentExecutionPolicy(agentSlug: string, task: string): SubagentExecutionPolicy {
  const complex = COMPLEX_WORK_RE.test(task) || HIGH_STAKES_RE.test(task);
  const boundedEvidence = agentSlug === "summarizer" || EVIDENCE_WORK_RE.test(task);
  if (boundedEvidence && !complex) {
    return { reasoning: "none", maxOutputTokens: 180, temperature: 0.2, topP: 0.8 };
  }
  return { reasoning: "high", maxOutputTokens: 500, temperature: 0.6, topP: 0.95 };
}
