/**
 * Bounded context capsules for durable orchestration steps.
 *
 * The ledger keeps full traces for inspection. A step prompt should not receive
 * that full transcript repeatedly; it gets a small capsule containing the user
 * goal, the current step, prior step summaries, retrieved context snippets, and
 * artifact references.
 */
import type { GoalRun, GoalRunArtifact, GoalRunStep } from "./goal-runs.ts";
import { redactString } from "./tool-policy.ts";

export interface ContextCapsuleInput {
  run: Pick<GoalRun, "title" | "route" | "contextSummary" | "steps" | "artifacts">;
  currentStep: string;
  relevantContext?: string[];
  artifacts?: GoalRunArtifact[];
  maxChars?: number;
}

export interface ContextCapsule {
  text: string;
  tokenEstimate: number;
  includedStepIds: string[];
  artifactIds: string[];
  truncated: boolean;
}

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function clean(value: string | undefined, max: number): string {
  const s = value ? redactString(value).replace(/\s+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max - 12) + " [truncated]" : s;
}

function stepLine(step: GoalRunStep): string | null {
  const summary = clean(step.summary, 900);
  if (!summary) return null;
  return `- Step ${step.index + 1} (${step.status}): ${clean(step.title, 160)} -> ${summary}`;
}

function artifactLine(a: GoalRunArtifact): string {
  const ref = a.ref ? ` [${a.ref}]` : "";
  const summary = a.summary ? `: ${clean(a.summary, 260)}` : "";
  return `- ${a.kind}: ${clean(a.title, 160)}${ref}${summary}`;
}

function pushBounded(lines: string[], line: string, maxChars: number): boolean {
  const next = [...lines, line].join("\n");
  if (next.length > maxChars) return false;
  lines.push(line);
  return true;
}

export function buildContextCapsule(input: ContextCapsuleInput): ContextCapsule {
  const maxChars = Math.max(1200, input.maxChars ?? 6000);
  const lines: string[] = [];
  const includedStepIds: string[] = [];
  const artifacts = [...(input.artifacts ?? []), ...input.run.artifacts].filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);
  const artifactIds: string[] = [];
  let truncated = false;

  pushBounded(lines, `Goal: ${clean(input.run.title, 500)}`, maxChars);
  pushBounded(lines, `Route: ${input.run.route}`, maxChars);
  pushBounded(lines, `Current step: ${clean(input.currentStep, 500)}`, maxChars);

  const summary = clean(input.run.contextSummary, 1200);
  if (summary) truncated = !pushBounded(lines, `Run summary so far: ${summary}`, maxChars) || truncated;

  const prior = input.run.steps
    .map((step) => ({ step, line: stepLine(step) }))
    .filter((entry): entry is { step: GoalRunStep; line: string } => !!entry.line);
  if (prior.length) {
    if (!pushBounded(lines, "Relevant prior step summaries:", maxChars)) truncated = true;
    for (const { step, line } of prior.slice(-8)) {
      if (!pushBounded(lines, line, maxChars)) {
        truncated = true;
        break;
      }
      includedStepIds.push(step.id);
    }
  }

  const ctx = (input.relevantContext ?? []).map((s) => clean(s, 1000)).filter(Boolean);
  if (ctx.length) {
    if (!pushBounded(lines, "Retrieved context snippets:", maxChars)) truncated = true;
    for (const snippet of ctx.slice(0, 6)) {
      if (!pushBounded(lines, `- ${snippet}`, maxChars)) {
        truncated = true;
        break;
      }
    }
  }

  if (artifacts.length) {
    if (!pushBounded(lines, "Artifact references:", maxChars)) truncated = true;
    for (const artifact of artifacts.slice(-10)) {
      if (!pushBounded(lines, artifactLine(artifact), maxChars)) {
        truncated = true;
        break;
      }
      artifactIds.push(artifact.id);
    }
  }

  const text = lines.join("\n");
  return { text, tokenEstimate: tokenEstimate(text), includedStepIds, artifactIds, truncated };
}
