/**
 * Durable GoalRun ledger.
 *
 * A GoalRun is the inspectable record of a multi-step assistant job: chat turn,
 * approved plan, skill pipeline, background task, or future resumable workflow.
 * It stores full traces for the user while later model calls receive only compact
 * summaries/capsules.
 */
import { generateId } from "ai";
import { join } from "node:path";
import { readJsonCached, writeJson, invalidateJsonCache } from "./json-store.ts";
import { DATA_DIR } from "./paths.ts";
import { withFileLock } from "./lock.ts";
import { redactString, redactToolOutput } from "./tool-policy.ts";

export const GOAL_RUNS_FILE = process.env["LEASH_GOAL_RUNS_FILE"] ?? join(DATA_DIR, "leash-goal-runs.json");

export type GoalRunStatus = "active" | "paused" | "failed" | "cancelled" | "completed";
export type GoalStepStatus = "pending" | "active" | "done" | "failed" | "skipped" | "cancelled";
export type GoalRunRoute = "chat" | "health" | "computer" | "files" | "vision" | "plan" | "skill" | "agent" | "background";

export interface GoalRunArtifact {
  id: string;
  kind: "text" | "file" | "url" | "task" | "image" | "run" | "other";
  title: string;
  ref?: string;
  summary?: string;
  createdAt: number;
}

export interface GoalRunModelTrace {
  id: string;
  stepId?: string;
  model: string;
  routeTier?: string;
  peerKey?: string;
  alias?: string;
  startedAt: number;
  finishedAt?: number;
  ttftMs?: number;
  tokens?: number;
  tokensPerSecond?: number;
  contextTokensEstimate?: number;
  reason?: string;
}

export interface GoalRunToolTrace {
  id: string;
  stepId?: string;
  toolName: string;
  route: GoalRunRoute;
  risk?: string;
  approval?: "none" | "required" | "approved" | "denied";
  argsHash?: string;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  summary?: string;
  error?: string;
}

export interface GoalRunStep {
  id: string;
  index: number;
  title: string;
  status: GoalStepStatus;
  route: GoalRunRoute;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  contextCapsule?: string;
  contextTokensEstimate?: number;
  summary?: string;
  artifacts: GoalRunArtifact[];
  errors: string[];
}

export interface GoalRun {
  id: string;
  chatId?: string;
  title: string;
  status: GoalRunStatus;
  route: GoalRunRoute;
  sensitivity: "private" | "shareable";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  steps: GoalRunStep[];
  modelTrace: GoalRunModelTrace[];
  toolTrace: GoalRunToolTrace[];
  contextSummary?: string;
  artifacts: GoalRunArtifact[];
  errors: string[];
  finalSynthesis?: string;
}

export interface GoalRunView {
  id: string;
  chatId?: string;
  title: string;
  status: GoalRunStatus;
  route: GoalRunRoute;
  sensitivity: "private" | "shareable";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  steps: Array<Pick<GoalRunStep, "id" | "index" | "title" | "status" | "route" | "model" | "startedAt" | "finishedAt" | "summary">>;
  artifacts: GoalRunArtifact[];
  errors: string[];
  finalSynthesis?: string;
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => undefined);
  return run;
}

function mutate<T>(fn: (runs: GoalRun[]) => Promise<{ runs: GoalRun[]; value: T }>): Promise<T> {
  return withLock(() =>
    withFileLock(GOAL_RUNS_FILE, async () => {
      const runs = normalize(await readJsonCached<unknown>(GOAL_RUNS_FILE, []));
      const out = await fn(runs);
      await writeJson(GOAL_RUNS_FILE, out.runs);
      invalidateJsonCache(GOAL_RUNS_FILE);
      return out.value;
    }),
  );
}

function cleanText(value: string | undefined, max = 4000): string | undefined {
  const s = value ? redactString(value).replace(/\s+/g, " ").trim() : "";
  return s ? (s.length > max ? s.slice(0, max - 12) + " [truncated]" : s) : undefined;
}

function normalizeArtifact(raw: Partial<GoalRunArtifact>): GoalRunArtifact | null {
  if (!raw || typeof raw.title !== "string") return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : generateId(),
    kind: raw.kind ?? "other",
    title: cleanText(raw.title, 240) ?? "Artifact",
    ...(typeof raw.ref === "string" && raw.ref ? { ref: raw.ref } : {}),
    ...(typeof raw.summary === "string" ? { summary: cleanText(raw.summary, 1000) } : {}),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
  };
}

function normalizeStep(raw: Partial<GoalRunStep>, index: number): GoalRunStep {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : generateId(),
    index: typeof raw.index === "number" ? raw.index : index,
    title: cleanText(raw.title, 240) ?? `Step ${index + 1}`,
    status: ["pending", "active", "done", "failed", "skipped", "cancelled"].includes(raw.status as string) ? (raw.status as GoalStepStatus) : "pending",
    route: (raw.route ?? "chat") as GoalRunRoute,
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    ...(typeof raw.startedAt === "number" ? { startedAt: raw.startedAt } : {}),
    ...(typeof raw.finishedAt === "number" ? { finishedAt: raw.finishedAt } : {}),
    ...(typeof raw.contextCapsule === "string" ? { contextCapsule: cleanText(raw.contextCapsule, 12_000) } : {}),
    ...(typeof raw.contextTokensEstimate === "number" ? { contextTokensEstimate: raw.contextTokensEstimate } : {}),
    ...(typeof raw.summary === "string" ? { summary: cleanText(raw.summary, 2000) } : {}),
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map((a) => normalizeArtifact(a)).filter((a): a is GoalRunArtifact => !!a) : [],
    errors: Array.isArray(raw.errors) ? raw.errors.map((e) => cleanText(String(e), 1000)).filter((e): e is string => !!e) : [],
  };
}

function normalize(raw: unknown): GoalRun[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Partial<GoalRun> => !!r && typeof r === "object")
    .map((r) => ({
      id: typeof r.id === "string" && r.id ? r.id : generateId(),
      ...(typeof r.chatId === "string" && r.chatId ? { chatId: r.chatId } : {}),
      title: cleanText(r.title, 240) ?? "Goal run",
      status: ["active", "paused", "failed", "cancelled", "completed"].includes(r.status as string) ? (r.status as GoalRunStatus) : "active",
      route: (r.route ?? "chat") as GoalRunRoute,
      sensitivity: r.sensitivity === "shareable" ? ("shareable" as const) : ("private" as const),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
      ...(typeof r.startedAt === "number" ? { startedAt: r.startedAt } : {}),
      ...(typeof r.finishedAt === "number" ? { finishedAt: r.finishedAt } : {}),
      steps: Array.isArray(r.steps) ? r.steps.map((s, i) => normalizeStep(s, i)) : [],
      modelTrace: Array.isArray(r.modelTrace) ? (redactToolOutput(r.modelTrace) as GoalRunModelTrace[]) : [],
      toolTrace: Array.isArray(r.toolTrace) ? (redactToolOutput(r.toolTrace) as GoalRunToolTrace[]) : [],
      ...(typeof r.contextSummary === "string" ? { contextSummary: cleanText(r.contextSummary, 6000) } : {}),
      artifacts: Array.isArray(r.artifacts) ? r.artifacts.map((a) => normalizeArtifact(a)).filter((a): a is GoalRunArtifact => !!a) : [],
      errors: Array.isArray(r.errors) ? r.errors.map((e) => cleanText(String(e), 1000)).filter((e): e is string => !!e) : [],
      ...(typeof r.finalSynthesis === "string" ? { finalSynthesis: cleanText(r.finalSynthesis, 4000) } : {}),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 500);
}

export async function loadGoalRuns(): Promise<GoalRun[]> {
  return normalize(await readJsonCached<unknown>(GOAL_RUNS_FILE, []));
}

export async function listGoalRuns(filter: { status?: GoalRunStatus; chatId?: string; limit?: number } = {}): Promise<GoalRun[]> {
  const limit = filter.limit ?? 100;
  return (await loadGoalRuns())
    .filter((r) => !filter.status || r.status === filter.status)
    .filter((r) => !filter.chatId || r.chatId === filter.chatId)
    .slice(0, limit);
}

export async function getGoalRun(id: string): Promise<GoalRun | null> {
  return (await loadGoalRuns()).find((r) => r.id === id) ?? null;
}

export function goalRunView(run: GoalRun): GoalRunView {
  return {
    id: run.id,
    ...(run.chatId ? { chatId: run.chatId } : {}),
    title: run.title,
    status: run.status,
    route: run.route,
    sensitivity: run.sensitivity,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    steps: run.steps.map((s) => ({
      id: s.id,
      index: s.index,
      title: s.title,
      status: s.status,
      route: s.route,
      ...(s.model ? { model: s.model } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
      ...(s.summary ? { summary: s.summary } : {}),
    })),
    artifacts: run.artifacts,
    errors: run.errors,
    ...(run.finalSynthesis ? { finalSynthesis: run.finalSynthesis } : {}),
  };
}

export async function createGoalRun(input: {
  id?: string;
  chatId?: string;
  title: string;
  route: GoalRunRoute;
  sensitivity?: "private" | "shareable";
  contextSummary?: string;
}): Promise<GoalRun> {
  const now = Date.now();
  const run: GoalRun = {
    id: input.id ?? generateId(),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    title: cleanText(input.title, 240) ?? "Goal run",
    status: "active",
    route: input.route,
    sensitivity: input.sensitivity ?? "private",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    steps: [],
    modelTrace: [],
    toolTrace: [],
    ...(input.contextSummary ? { contextSummary: cleanText(input.contextSummary, 6000) } : {}),
    artifacts: [],
    errors: [],
  };
  return mutate(async (runs) => {
    const next = [run, ...runs.filter((r) => r.id !== run.id)].slice(0, 500);
    return { runs: next, value: run };
  });
}

export async function startGoalRunStep(
  runId: string,
  input: { id?: string; title: string; route: GoalRunRoute; model?: string; contextCapsule?: string; contextTokensEstimate?: number },
): Promise<GoalRunStep> {
  return mutate(async (runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) throw new Error(`goal run not found: ${runId}`);
    const now = Date.now();
    const step: GoalRunStep = {
      id: input.id ?? generateId(),
      index: run.steps.length,
      title: cleanText(input.title, 240) ?? `Step ${run.steps.length + 1}`,
      status: "active",
      route: input.route,
      ...(input.model ? { model: input.model } : {}),
      startedAt: now,
      ...(input.contextCapsule ? { contextCapsule: cleanText(input.contextCapsule, 12_000) } : {}),
      ...(typeof input.contextTokensEstimate === "number" ? { contextTokensEstimate: input.contextTokensEstimate } : {}),
      artifacts: [],
      errors: [],
    };
    run.steps.push(step);
    run.status = "active";
    run.updatedAt = now;
    return { runs, value: step };
  });
}

export async function updateGoalRunStep(
  runId: string,
  stepId: string,
  patch: Partial<Pick<GoalRunStep, "status" | "summary" | "contextCapsule" | "contextTokensEstimate" | "model">> & { error?: string; artifact?: Partial<GoalRunArtifact> },
): Promise<GoalRunStep | null> {
  return mutate(async (runs) => {
    const run = runs.find((r) => r.id === runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return { runs, value: null };
    const now = Date.now();
    if (patch.status) {
      step.status = patch.status;
      if (["done", "failed", "skipped", "cancelled"].includes(patch.status)) step.finishedAt = now;
    }
    if (patch.summary !== undefined) step.summary = cleanText(patch.summary, 2000);
    if (patch.contextCapsule !== undefined) step.contextCapsule = cleanText(patch.contextCapsule, 12_000);
    if (patch.contextTokensEstimate !== undefined) step.contextTokensEstimate = patch.contextTokensEstimate;
    if (patch.model !== undefined) step.model = patch.model;
    if (patch.error) step.errors.push(cleanText(patch.error, 1000) ?? "unknown error");
    if (patch.artifact) {
      const artifact = normalizeArtifact(patch.artifact);
      if (artifact) {
        step.artifacts.push(artifact);
        run.artifacts.push(artifact);
      }
    }
    run.updatedAt = now;
    return { runs, value: step };
  });
}

export async function recordGoalRunModelTrace(runId: string, trace: Omit<GoalRunModelTrace, "id" | "startedAt"> & { id?: string; startedAt?: number }): Promise<void> {
  await mutate(async (runs) => {
    const run = runs.find((r) => r.id === runId);
    if (run) {
      const clean = redactToolOutput(trace);
      run.modelTrace.push({ ...clean, id: trace.id ?? generateId(), startedAt: trace.startedAt ?? Date.now() });
      run.updatedAt = Date.now();
    }
    return { runs, value: undefined };
  });
}

export async function recordGoalRunToolTrace(runId: string, trace: Omit<GoalRunToolTrace, "id" | "startedAt"> & { id?: string; startedAt?: number }): Promise<void> {
  await mutate(async (runs) => {
    const run = runs.find((r) => r.id === runId);
    if (run) {
      const clean = redactToolOutput(trace);
      run.toolTrace.push({ ...clean, id: trace.id ?? generateId(), startedAt: trace.startedAt ?? Date.now() });
      run.updatedAt = Date.now();
    }
    return { runs, value: undefined };
  });
}

export async function appendGoalRunError(runId: string, error: string): Promise<void> {
  await mutate(async (runs) => {
    const run = runs.find((r) => r.id === runId);
    if (run) {
      run.errors.push(cleanText(error, 1000) ?? "unknown error");
      run.updatedAt = Date.now();
    }
    return { runs, value: undefined };
  });
}

export async function finishGoalRun(runId: string, status: Exclude<GoalRunStatus, "active">, finalSynthesis?: string): Promise<GoalRun | null> {
  return mutate(async (runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return { runs, value: null };
    const now = Date.now();
    run.status = status;
    run.updatedAt = now;
    run.finishedAt = now;
    if (finalSynthesis !== undefined) run.finalSynthesis = cleanText(finalSynthesis, 4000);
    return { runs, value: run };
  });
}

export async function pauseGoalRun(runId: string, reason?: string): Promise<GoalRun | null> {
  if (reason) await appendGoalRunError(runId, reason);
  return finishGoalRun(runId, "paused");
}
