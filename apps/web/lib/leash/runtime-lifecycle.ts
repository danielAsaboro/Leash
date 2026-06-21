import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { StreamTextTransform, ToolSet } from "ai";
import { DATA_DIR } from "@mycelium/leash-core/json-store";
import { toolPolicy, type ToolRoute } from "@mycelium/leash-core/tool-policy";

export const leashRuntimeContextSchema = z.object({
  requestId: z.string().min(1),
  chatId: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  route: z.enum(["chat", "health", "computer", "files", "vision", "plan", "skill", "agent", "background"]),
  sensitivity: z.enum(["private", "public"]),
  startedAt: z.number().int().nonnegative(),
});
export type LeashRuntimeContext = z.infer<typeof leashRuntimeContextSchema>;

export function createLeashRuntimeContext(input: {
  route: LeashRuntimeContext["route"];
  chatId?: string;
  runId?: string;
  stepId?: string;
  sensitivity?: LeashRuntimeContext["sensitivity"];
}): LeashRuntimeContext {
  const suffix = randomUUID();
  return {
    requestId: `req-${suffix}`,
    chatId: input.chatId ?? "background",
    runId: input.runId ?? `run-${suffix}`,
    stepId: input.stepId ?? `step-${suffix}`,
    route: input.route,
    sensitivity: input.sensitivity ?? "private",
    startedAt: Date.now(),
  };
}

export const leashToolContextSchema = z.object({
  toolName: z.string().min(1),
  scope: z.string().min(1),
  risk: z.string().min(1),
  route: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  chatId: z.string().min(1),
});
export type LeashToolContext = z.infer<typeof leashToolContextSchema>;

/** Add a validated, least-privilege execution context contract to every local or MCP tool. */
export function withScopedToolContext(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, {
    ...definition,
    contextSchema: leashToolContextSchema,
  }])) as ToolSet;
}

/** Build one context entry per tool; tools never receive the full request environment. */
export function toolContextsFor(tools: ToolSet, runtime: LeashRuntimeContext): Record<string, LeashToolContext> {
  return Object.fromEntries(Object.keys(tools).map((name) => {
    const policy = toolPolicy(name);
    return [name, {
      toolName: name,
      scope: policy.scope,
      risk: policy.risk,
      route: runtime.route,
      runId: runtime.runId,
      stepId: runtime.stepId,
      chatId: runtime.chatId,
    } satisfies LeashToolContext];
  }));
}

type LifecycleRecord = {
  ts: string;
  event: "agent_start" | "step_start" | "first_output" | "step_end" | "tool_start" | "tool_end" | "agent_end";
  requestId: string;
  chatId: string;
  runId: string;
  stepId: string;
  route: ToolRoute;
  callId?: string;
  modelId?: string;
  stepNumber?: number;
  toolName?: string;
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
};

const LIFECYCLE_FILE = process.env["LEASH_AGENT_LIFECYCLE_FILE"] ?? join(DATA_DIR, "audit", "agent-lifecycle.jsonl");

export function recordAgentLifecycle(runtime: LeashRuntimeContext, record: Omit<LifecycleRecord, "ts" | "requestId" | "chatId" | "runId" | "stepId" | "route">): void {
  mkdirSync(dirname(LIFECYCLE_FILE), { recursive: true });
  appendFileSync(LIFECYCLE_FILE, `${JSON.stringify({
    ts: new Date().toISOString(),
    requestId: runtime.requestId,
    chatId: runtime.chatId,
    runId: runtime.runId,
    stepId: runtime.stepId,
    route: runtime.route,
    ...record,
  } satisfies LifecycleRecord)}\n`);
}

/** Measure the first meaningful model output without buffering or altering the stream. */
export function createLifecycleTimingTransform(runtime: LeashRuntimeContext): StreamTextTransform<ToolSet> {
  return () => {
    let recorded = false;
    return new TransformStream({
      transform(part, controller) {
        if (!recorded && ["text-delta", "reasoning-delta", "tool-call"].includes(part.type)) {
          recorded = true;
          recordAgentLifecycle(runtime, { event: "first_output", ttftMs: Date.now() - runtime.startedAt });
        }
        controller.enqueue(part);
      },
    });
  };
}

export const LEASH_AGENT_TIMEOUT = {
  // A parent step can legitimately contain several specialist tool calls, and each specialist
  // can run its own local model/tool loop. Keep the first-output watchdog strict, but budget the
  // enclosing step for nested work on a single-device inference queue.
  totalMs: 300_000,
  stepMs: 180_000,
  chunkMs: 45_000,
  toolMs: 30_000,
} as const;
