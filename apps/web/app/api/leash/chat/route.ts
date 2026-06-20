/**
 * `POST /api/leash/chat` — the Leash assistant (Vercel AI SDK), with persistence.
 *
 * The client sends only the **last** message + the chat `id` + a `trigger`
 * (`prepareSendMessagesRequest`), so we rebuild history from the store:
 *   · submit-user-message      → append the new user message
 *   · regenerate-assistant-message → drop the target assistant message, re-run
 * We validate the stored+new messages against current tool/metadata schemas, stream the
 * on-device tool loop, persist the full thread in `onFinish`, and `consumeStream()` so a
 * client disconnect still saves. Server-side message IDs keep stored threads stable —
 * which the future "dreaming"/consolidation pass relies on.
 */
import { convertToModelMessages, validateUIMessages, createIdGenerator, createUIMessageStream, createUIMessageStreamResponse, type ToolSet } from "ai";
import { z } from "zod";
import { VISION_MODEL, COMPUTER_MODEL, QVAC_OPENAI_URL, resolvedChatAlias, routedChatModel } from "../../../../lib/leash/provider.ts";
import { buildLeashAgent, type LeashCallOptions } from "../../../../lib/leash/agent.ts";
import { tagsForAlias, type RouteOption } from "@mycelium/leash-core/routing";
import { leashTools } from "../../../../lib/leash/tools.ts";
import { preferenceTexts } from "../../../../lib/leash/memories-store.ts";
import { skillsSystemSection, activeSkillsSection } from "../../../../lib/leash/skill-tools.ts";
import { COMPUTER_TOOL_NAMES, BASH_TOOL_NAMES } from "../../../../lib/leash/tool-lanes.ts";
import { buildSkillRunner, runSkillAsPipeline } from "../../../../lib/leash/skill-runner.ts";
import { buildAgentTools } from "../../../../lib/leash/agent-runner.ts";
import { listAgents } from "../../../../lib/leash/agents-store.ts";
import { buildPlanTool, planDataSchema } from "../../../../lib/leash/plan-tools.ts";
import { KEEPALIVE_TOOLS } from "../../../../lib/leash/keepalive-tool.ts";
import { deriveLaneBudget } from "../../../../lib/leash/lane-budget.ts";
import { runFileFinderFastPath, shouldRunFileFinderFastPath } from "../../../../lib/leash/file-finder-fast-path.ts";
import { directBashCommandForSimpleTurn, runDirectBashCommand } from "../../../../lib/leash/bash-command-fast-path.ts";
import { directBrokerCallForSimpleTurn, runDirectBrokerCall } from "../../../../lib/leash/broker-fast-path.ts";
import { directAnswerForSimpleTurn, directAnswerForSkillMetadataTurn, localInferenceUnavailableAnswer } from "../../../../lib/leash/direct-answer.ts";
import { directHealthSafetyCallForSimpleTurn, runDirectHealthSafetyCall } from "../../../../lib/leash/health-fast-path.ts";
import { buildCapabilityBrokers } from "../../../../lib/leash/tool-brokers.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { getPrompt } from "../../../../lib/leash/prompts-store.ts";
import { loadMainAgentBase } from "../../../../lib/leash/main-agent.ts";
import { getConstitution } from "../../../../lib/leash/constitution.ts";
import { filterEnabledTools, disabledTools, withApprovalGates } from "../../../../lib/leash/tool-config.ts";
import { loadRecord, saveChat } from "../../../../lib/leash/chat-store.ts";
import { inlineFileAttachments } from "../../../../lib/leash/attachments.ts";
import { compact } from "../../../../lib/leash/compactor.ts";
import { classifyEffort, effortConfig } from "../../../../lib/leash/effort.ts";
import { conductTurn, type ConductorResult } from "../../../../lib/leash/conductor.ts";
import {
  barFromGuardedTurn,
  capabilityBarFromConductorRoute,
  pickLocalGeneral,
  publicMeshRouteBlocked,
  rankConductorRoute,
  type ConductorRoute,
  type ConductorRouteDecision,
} from "../../../../lib/leash/conductor-core.ts";
import { beginGeneration } from "../../../../lib/leash/inflight.ts";
import { subscribeElicitations } from "../../../../lib/leash/elicitations.ts";
import { interjectRequested, clearInterject } from "../../../../lib/leash/interject-store.ts";
import type { EffortTier, LeashUIMessage } from "../../../../lib/leash/types.ts";
import { AuditLog } from "@mycelium/shared";
import { enforceToolPolicy, type ToolRoute } from "@mycelium/leash-core/tool-policy";
import { buildContextCapsule } from "@mycelium/leash-core/context-capsule";
import {
  appendGoalRunError,
  createGoalRun,
  finishGoalRun,
  getGoalRun,
  goalRunView,
  recordGoalRunModelTrace,
  startGoalRunStep,
  updateGoalRunStep,
} from "@mycelium/leash-core/goal-runs";
import { DATA_DIR } from "../../../../lib/leash/json-store.ts";
import {
  CHAT_APPROVAL_NOTE,
  CHAT_CITATION_NOTE,
  CHAT_COMPUTER_MODE_NOTE,
  CHAT_FILES_MODE_NOTE,
  CHAT_PLAN_MODE_NOTE,
  CHAT_THINKING_NOTE,
  NO_THINK_DIRECTIVE,
  buildDisabledToolsNote,
  buildGoalsSection,
  buildPreferenceSection,
  buildSoulSection,
  buildSummarySection,
} from "../../../../lib/leash/prompt.ts";
import { join } from "node:path";

/** Singleton AuditLog for conductor decisions (logs/conductor.jsonl relative to DATA_DIR). */
const conductorAudit = new AuditLog("conductor", join(DATA_DIR, "..", "logs"));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A deterministic step-pipeline turn runs several sequential model calls (one per step), so a turn can
// run a few minutes; keep the ceiling generous (local dev doesn't hard-enforce, but be honest about it).
export const maxDuration = 300;

// `.optional()` on the OBJECT: user messages carry no metadata at all (only assistant messages get
// it via `messageMetadata`), so the schema must accept `undefined` or validation fails on every
// stored thread and falls back to raw history.
const metadataSchema = z
  .object({
    createdAt: z.number().optional(),
    finishedAt: z.number().optional(),
    model: z.string().optional(),
    totalTokens: z.number().optional(),
    effort: z.enum(["quick", "standard", "deep"]).optional(),
  })
  .optional();

const skillDataSchema = z.object({
  mode: z.enum(["explicit", "automatic"]),
  skills: z.array(z.object({ slug: z.string(), name: z.string() })).min(1),
});

const conductorDataSchema = z.object({
  tier: z.string(),
  alias: z.string(),
  peerKey: z.string().optional(),
  meshId: z.string().optional(),
  reason: z.string(),
  viaFastPath: z.boolean(),
});

const goalRunDataSchema = z.object({
  id: z.string(),
  chatId: z.string().optional(),
  title: z.string(),
  status: z.enum(["active", "paused", "failed", "cancelled", "completed"]),
  route: z.enum(["chat", "health", "computer", "files", "vision", "plan", "skill", "agent", "background"]),
  sensitivity: z.enum(["private", "shareable"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  steps: z.array(
    z.object({
      id: z.string(),
      index: z.number(),
      title: z.string(),
      status: z.enum(["pending", "active", "done", "failed", "skipped", "cancelled"]),
      route: z.enum(["chat", "health", "computer", "files", "vision", "plan", "skill", "agent", "background"]),
      model: z.string().optional(),
      startedAt: z.number().optional(),
      finishedAt: z.number().optional(),
      summary: z.string().optional(),
    }),
  ),
  artifacts: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), ref: z.string().optional(), summary: z.string().optional(), createdAt: z.number() })),
  errors: z.array(z.string()),
  finalSynthesis: z.string().optional(),
});

/**
 * Empty-turn guard (SmallCode quality-monitor port): an honest message to append when the model
 * finishes a turn with no answer text. If it ran tools, name them; else nudge to rephrase. Loosely
 * typed + fully defensive — this runs in the stream's tail and must never throw.
 */
async function emptyTurnFallback(result: unknown): Promise<string> {
  let toolNames: string[] = [];
  try {
    const steps = ((await (result as { steps?: Promise<unknown[]> }).steps) ?? []) as Array<{ toolCalls?: Array<{ toolName?: string }> }>;
    toolNames = [...new Set(steps.flatMap((s) => (s.toolCalls ?? []).map((c) => c.toolName).filter((n): n is string => !!n)))];
  } catch {
    /* fall through to the generic message */
  }
  return toolNames.length > 0
    ? `I ran ${toolNames.join(", ")} but didn't write up an answer. Ask me to continue, or rephrase if you'd like a summary.`
    : "I couldn't produce a response to that — try rephrasing it, or breaking it into smaller steps.";
}

async function pendingApprovalFallback(result: unknown): Promise<string | null> {
  try {
    const steps = ((await (result as { steps?: Promise<unknown[]> }).steps) ?? []) as Array<{
      finishReason?: string;
      toolCalls?: Array<{ toolName?: string }>;
      toolResults?: unknown[];
    }>;
    const pending = steps.flatMap((s) =>
      s.finishReason === "tool-calls" && (s.toolCalls?.length ?? 0) > 0 && (s.toolResults?.length ?? 0) === 0
        ? (s.toolCalls ?? []).map((c) => c.toolName).filter((n): n is string => !!n)
        : [],
    );
    const names = [...new Set(pending)];
    return names.length ? `Waiting for approval to run ${names.join(", ")}.` : null;
  } catch {
    return null;
  }
}

/**
 * Forgiving-parser DETECTOR (SmallCode port, measure-and-nudge scope): did the model emit a tool
 * call as plain TEXT (`<tool_call>…</tool_call>`, Liquid `<|tool_call_start|>`, `functions.x(...)`,
 * or a bare `{"name":…,"arguments":…}`) instead of actually invoking it? We can't re-run it inside
 * a streamed turn, so we log it (to gauge how often this still happens now that compound tools
 * exist — the data that decides whether the full streaming-recovery middleware is worth the risk)
 * and the route adds an honest nudge. Returns the tool name when identifiable.
 */
function toolCallAsText(text: string): { matched: boolean; toolName?: string } {
  const tagged = /<tool_call>[\s\S]*?<\/tool_call>/i.test(text) || /<\|tool_call_start\|>/i.test(text);
  const fnStyle = /(?:^|[\s`])functions?\.[a-z_][a-z0-9_]*\s*\(/i.test(text);
  const bareJson = /\{\s*"name"\s*:\s*"[a-z0-9_]+"\s*,\s*"(?:arguments|parameters|input)"\s*:/i.test(text);
  if (!tagged && !fnStyle && !bareJson) return { matched: false };
  const m = text.match(/"name"\s*:\s*"([a-z0-9_]+)"/i) ?? text.match(/functions?\.([a-z0-9_]+)/i) ?? text.match(/<tool_call>\s*([a-z0-9_]+)/i);
  return { matched: true, toolName: m?.[1] };
}

/** The text-parts join of the most recent user message (conductor + effort grading). */
function lastUserText(messages: LeashUIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ");
}

/** Vision routing: the latest user message carries an image (file part) → use the VLM. */
function isImageTurn(messages: LeashUIMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).some((p) => p?.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
}

/**
 * Computer-use routing: screen/GUI/app-control intent → the (possibly bigger, possibly
 * mesh-delegated) computer driver — a NO-OP while `LEASH_COMPUTER_MODEL` is unset
 * apart from the raised step budget below.
 */
const COMPUTER_RE =
  /\b(computer-use|list_apps|get_app_state|type_text|press_key|set_value|screen ?shot\w*|screen|click\w*|double.?click\w*|type(?!\s+of)|typing|scroll\w*|cursor|mouse|keyboard|open (?:the |this )?app\w*|launch\w*)\b/i;
function isComputerIntent(messages: LeashUIMessage[]): boolean {
  return COMPUTER_RE.test(lastUserText(messages));
}

/**
 * Files routing: RETRIEVAL intent over the user's files/Apple Notes/code → the sandboxed `bash`
 * tool preferred over GUI computer use. Matches a retrieval verb
 * near a file-ish noun, a bare `grep`/`glob`, or "in my files/Apple Notes/…". Checked BEFORE the
 * computer route so "search/read Apple Notes" gets the safe sandbox, while GUI verbs still
 * fall through to the computer route.
 */
const FILES_RE =
  /\b(?:grep|ripgrep|\brg\b|glob)\b|\b(?:search|find|look(?:ing)?|list|show|read|cat|explore|scan|locate|count|summari[sz]e)\b[\s\S]{0,30}\b(?:files?|notes?|docs?|documents?|folders?|director(?:y|ies)|code(?:base)?|repo(?:sitor(?:y|ies)|s)?|projects?|workspace|markdown|\.(?:md|txt|json|csv|ya?ml))\b|\bin (?:my|the|this) (?:files?|notes?|docs?|code(?:base)?|folder|director(?:y|ies)|projects?|repo(?:sitor(?:y|ies)|s)?|workspace)\b/i;
const BASH_EXEC_RE =
  /\b(?:use|call|invoke)\b[\s\S]{0,40}\b(?:sandboxed\s+)?(?:bash|shell)\b|\b(?:bash|shell)\s+(?:tool|command)\b|\b(?:run|execute)\b[\s\S]{0,30}\b(?:in|with|using|via)\s+(?:sandboxed\s+)?(?:bash|shell)\b/i;
function isFilesIntent(messages: LeashUIMessage[]): boolean {
  const text = lastUserText(messages);
  return FILES_RE.test(text) || BASH_EXEC_RE.test(text);
}

const HYPHA_BASE = process.env["LEASH_BROKER_HYPHA_URL"] ?? "http://127.0.0.1:11437";

interface PeerRow {
  deviceId?: string;
  providerKey?: string;
  peerId?: string;
  models?: string[];
  meshId?: string;
  meshLabel?: string;
  visibility?: string;
  tier?: number;
  live?: boolean;
  inflight?: number;
  pricePerKiloToken?: number;
}

interface MeshMembership {
  meshId: string;
  visibility?: string;
  tier?: number;
}

function peerRouteTier(row: PeerRow, meshById: Map<string, MeshMembership>): RouteOption["tier"] {
  const visibility = row.visibility ?? (row.meshId ? meshById.get(row.meshId)?.visibility : undefined);
  return visibility === "public" ? "public" : "private";
}

/**
 * Build RouteOption[] from QVAC's live local inventory plus Hypha's live mesh peer view.
 *
 * QVAC `/v1/models` is the source of truth for this device. Hypha `/peers` adds reachable peer
 * models with tier metadata. Missing mesh visibility fails closed to private.
 */
async function fetchRouteOptions(): Promise<RouteOption[]> {
  type ModelsBody = { data?: { id?: string }[] };
  const options: RouteOption[] = [];
  try {
    const modelsRes = await fetch(`${QVAC_OPENAI_URL}/models`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (modelsRes.ok) {
      const mb = (await modelsRes.json()) as ModelsBody;
      for (const row of mb.data ?? []) {
        if (!row.id) continue;
        options.push({ tier: "device", alias: row.id, tags: tagsForAlias(row.id), pricePerKiloToken: 0, inflight: 0 });
      }
    }
  } catch {
    /* local serve down: mesh peers below may still be available for guarded routes */
  }

  try {
    // TODO(mesh): Add a live cross-device smoke once Hypha is running on a non-solo mesh,
    // so device -> private mesh -> public mesh delegation is verified end to end.
    const peersRes = await fetch(`${HYPHA_BASE}/peers`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!peersRes.ok) return options;
    const pb = (await peersRes.json()) as { peers?: PeerRow[]; meshes?: MeshMembership[] };
    const meshById = new Map((pb.meshes ?? []).map((m) => [m.meshId, m]));
    for (const row of pb.peers ?? []) {
      if (row.live === false || !row.providerKey) continue;
      for (const alias of row.models ?? []) {
        options.push({
          tier: peerRouteTier(row, meshById),
          alias,
          tags: tagsForAlias(alias),
          peerKey: row.providerKey,
          ...(row.meshId ? { meshId: row.meshId } : {}),
          pricePerKiloToken: row.pricePerKiloToken ?? 0,
          inflight: row.inflight ?? 0,
        });
      }
    }
  } catch {
    /* hypha down: routing remains on this device */
  }
  return options;
}

function routeFailure(status: number, error: string, extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error, ...(extra ?? {}) }, { status });
}

function latestMessage(messages: LeashUIMessage[]): LeashUIMessage | undefined {
  return messages[messages.length - 1];
}

function userTurnCount(messages: LeashUIMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

function hasFilePart(messages: LeashUIMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).some((p) => p?.type === "file");
}

function hasToolApprovalResponse(messages: LeashUIMessage[]): boolean {
  const latest = latestMessage(messages);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((latest?.parts as any[]) ?? []).some((p) => typeof p?.state === "string" && (p.state === "approval-responded" || p.state === "output-denied"));
}

function conductorBypassReason(input: { messages: LeashUIMessage[]; plan?: boolean }): string | null {
  if (input.plan) return "plan mode";
  const latest = latestMessage(input.messages);
  if (!latest || latest.role !== "user") return "non-user continuation";
  if (hasFilePart(input.messages)) return "file or image attachment";
  if (hasToolApprovalResponse(input.messages)) return "tool approval continuation";
  return null;
}

function recordConductorTurnDecision(result: ConductorResult, answeredDirectly: boolean, overrideReason?: string): void {
  try {
    conductorAudit.record({
      event: "note",
      modelId: result.conductorAlias,
      durationMs: result.latencyMs,
      extra: {
        role: "conductor",
        ok: result.ok,
        action: result.ok ? result.decision.action : "route",
        alias: result.ok && result.decision.action === "route" ? result.decision.route.alias : result.conductorAlias,
        reason: overrideReason ?? (result.ok ? (result.decision.action === "route" ? result.decision.route.reason : "direct answer") : result.failureReason),
        answeredDirectly,
        ...(!result.ok && result.raw ? { rawPreview: result.raw.slice(0, 300) } : {}),
      },
    });
  } catch {
    /* audit write must never break a turn */
  }
}

function isExplicitModelOverride(chosenModel: string | undefined, result: ConductorResult): boolean {
  if (!chosenModel) return false;
  const row = result.inventory.find((m) => m.alias === chosenModel);
  return row ? !row.isDefault : true;
}

async function streamConductorAnswer(input: { chatId: string; messages: LeashUIMessage[]; alias: string; answer: string; reason: string }): Promise<Response> {
  const stream = createUIMessageStream<LeashUIMessage>({
    originalMessages: input.messages,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: ({ writer }) => {
      const started = Date.now();
      writer.write({ type: "data-conductor", data: { tier: "device", alias: input.alias, reason: input.reason, viaFastPath: true } });
      writer.write({ type: "message-metadata", messageMetadata: { createdAt: started, model: input.alias, effort: "quick" satisfies EffortTier } });
      writer.write({ type: "text-start", id: "conductor-answer" });
      writer.write({ type: "text-delta", id: "conductor-answer", delta: input.answer });
      writer.write({ type: "text-end", id: "conductor-answer" });
      writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
    },
    onFinish: ({ messages: finalMessages }) => {
      void saveChat({ chatId: input.chatId, messages: finalMessages as LeashUIMessage[] });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

async function streamEarlyDeterministicToolTurn(input: {
  chatId: string;
  messages: LeashUIMessage[];
  route: ToolRoute;
  alias: string;
  reason: string;
  skill?: { slug: string; name: string };
  registry: "base" | "brokers";
  run: (tools: ToolSet) => Promise<string | null>;
}): Promise<Response> {
  const goalRunId = createIdGenerator({ prefix: "run", size: 16 })();
  const title = lastUserText(input.messages) || "Leash turn";
  const goalRun = await createGoalRun({
    id: goalRunId,
    chatId: input.chatId,
    title,
    route: input.route,
    sensitivity: "private",
  });
  const mainStep = await startGoalRunStep(goalRunId, {
    title: "Run deterministic tool path",
    route: input.route,
    model: input.alias,
    contextCapsule: title.slice(0, 6000),
    contextTokensEstimate: Math.ceil(title.length / 4),
  });

  const baseTools = { ...leashTools, ...(await leashMcpTools()) };
  const selectedTools = input.registry === "brokers" ? buildCapabilityBrokers(baseTools) : baseTools;
  const enabledTools = await filterEnabledTools(selectedTools);
  const policyTools = enforceToolPolicy(enabledTools, { route: input.route, runId: goalRunId, stepId: mainStep.id, publicMesh: false });

  const stream = createUIMessageStream<LeashUIMessage>({
    originalMessages: input.messages,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: async ({ writer }) => {
      writer.write({ type: "message-metadata", messageMetadata: { createdAt: Date.now(), model: input.alias, effort: "quick" satisfies EffortTier } });
      writer.write({ type: "data-conductor", data: { tier: "device", alias: input.alias, reason: input.reason, viaFastPath: true } });
      writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(goalRun) });
      if (input.skill) writer.write({ type: "data-skill", data: { mode: "automatic", skills: [input.skill] } });

      let text: string;
      try {
        const out = await input.run(policyTools);
        if (out === null) throw new Error(`${input.alias} unavailable`);
        text = out || "(no output)";
        await updateGoalRunStep(goalRunId, mainStep.id, { status: "done", summary: text.slice(0, 1200) });
        await finishGoalRun(goalRunId, "completed", text);
      } catch (e) {
        text = `The deterministic tool path failed: ${e instanceof Error ? e.message : String(e)}`;
        await updateGoalRunStep(goalRunId, mainStep.id, { status: "failed", error: text });
        await appendGoalRunError(goalRunId, text);
        await finishGoalRun(goalRunId, "failed", text);
      }

      const finalRun = await getGoalRun(goalRunId);
      if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
      writer.write({ type: "text-start", id: "deterministic-tool-out" });
      writer.write({ type: "text-delta", id: "deterministic-tool-out", delta: text });
      writer.write({ type: "text-end", id: "deterministic-tool-out" });
      writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
    },
    onFinish: ({ messages: finalMessages }) => {
      void saveChat({ chatId: input.chatId, messages: finalMessages as LeashUIMessage[] });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

type ChatPostBody = { id: string; trigger?: string; messageId?: string; message?: LeashUIMessage; voice?: boolean; plan?: boolean; model?: string };

export async function POST(req: Request): Promise<Response> {
  let body: ChatPostBody;
  try {
    body = (await req.json()) as ChatPostBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { id, trigger, messageId, message, voice, plan } = body;
  // User-chosen chat model alias from the input picker (validated against the regex in the schema).
  const chosenModel = typeof body.model === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(body.model) ? body.model : undefined;

  // A fresh turn STARTS here: clear any interject flag so a follow-up that ended the PREVIOUS turn
  // doesn't immediately end this one (this turn IS that follow-up).
  clearInterject(id);

  // Rebuild the working history from the store + the incoming trigger.
  const record = await loadRecord(id);
  const previous = record?.messages ?? [];
  let messages: LeashUIMessage[];
  if (trigger === "regenerate-message" && messageId) {
    const idx = previous.findIndex((m) => m.id === messageId);
    messages = idx === -1 ? previous : previous.slice(0, idx); // drop the assistant msg → regenerate
  } else if (message) {
    // REPLACE-BY-ID, not append: a tool-approval response mutates the LAST ASSISTANT
    // message in place client-side and resends it under the SAME id — appending would
    // duplicate it in the stored thread. A normal user submit has a fresh id (i === -1)
    // and still appends.
    const i = previous.findIndex((m) => m.id === message.id);
    messages = i === -1 ? [...previous, message] : [...previous.slice(0, i), message, ...previous.slice(i + 1)];
  } else {
    messages = previous;
  }

  const conductorText = lastUserText(messages);
  const requestedComputer = isComputerIntent(messages);
  const conductorBypass = conductorBypassReason({ messages, plan });
  const directAnswer = !conductorBypass && !chosenModel && !requestedComputer ? directAnswerForSimpleTurn(conductorText) : null;
  if (directAnswer) {
    return streamConductorAnswer({
      chatId: id,
      messages,
      alias: "direct",
      answer: directAnswer,
      reason: "deterministic direct answer",
    });
  }
  const directSkillMetadataAnswer = !conductorBypass && !chosenModel && !requestedComputer ? directAnswerForSkillMetadataTurn(conductorText) : null;
  if (directSkillMetadataAnswer) {
    return streamConductorAnswer({
      chatId: id,
      messages,
      alias: "direct",
      answer: directSkillMetadataAnswer,
      reason: "deterministic skill metadata answer",
    });
  }
  if (!conductorBypass && !chosenModel && !requestedComputer && conductorText.trim()) {
    const directBashCommand = directBashCommandForSimpleTurn(conductorText);
    if (directBashCommand) {
      return streamEarlyDeterministicToolTurn({
        chatId: id,
        messages,
        route: "files",
        alias: "bash",
        reason: "deterministic bash command fast path",
        registry: "base",
        run: (tools) => runDirectBashCommand(directBashCommand, tools),
      });
    }

    if (/\bfile-finder\b/i.test(conductorText) && shouldRunFileFinderFastPath(conductorText)) {
      return streamEarlyDeterministicToolTurn({
        chatId: id,
        messages,
        route: "files",
        alias: "bash",
        reason: "deterministic file-finder fast path",
        skill: { slug: "file-finder", name: "file-finder" },
        registry: "base",
        run: async (tools) => {
          const out = await runFileFinderFastPath(conductorText, tools);
          return out?.text.trim() || "No matching local file results were found.";
        },
      });
    }

    const directBrokerCall = directBrokerCallForSimpleTurn(conductorText);
    if (directBrokerCall) {
      const skillByBroker: Record<string, { slug: string; name: string }> = {
        context_run: directBrokerCall.action === "understory_today" ? { slug: "daily-paper", name: "daily-paper" } : { slug: "context-grounding", name: "context-grounding" },
        memory_run: { slug: "memory-keeper", name: "memory-keeper" },
        tasks_run: { slug: "task-manager", name: "task-manager" },
      };
      return streamEarlyDeterministicToolTurn({
        chatId: id,
        messages,
        route: "chat",
        alias: directBrokerCall.broker,
        reason: `deterministic broker fast path: ${directBrokerCall.action}`,
        skill: skillByBroker[directBrokerCall.broker],
        registry: "brokers",
        run: (tools) => runDirectBrokerCall(directBrokerCall, tools),
      });
    }

    const directHealthCall = directHealthSafetyCallForSimpleTurn(conductorText);
    if (directHealthCall) {
      return streamEarlyDeterministicToolTurn({
        chatId: id,
        messages,
        route: "health",
        alias: "health-safety",
        reason: "deterministic health-safety fast path",
        skill: { slug: "health-safety", name: "health-safety" },
        registry: "base",
        run: (tools) => runDirectHealthSafetyCall(directHealthCall, tools),
      });
    }
  }

  let conductorRoute: ConductorRoute | null = null;
  let forcedModelAlias: string | undefined = chosenModel;
  if (!conductorBypass && conductorText.trim()) {
    const releaseConductor = beginGeneration();
    let conductorResult: ConductorResult;
    try {
      conductorResult = await conductTurn({
        userPrompt: conductorText,
        metadata: {
          messageCount: messages.length,
          userTurnCount: userTurnCount(messages),
          voice: !!voice,
          selectedModel: chosenModel ?? null,
          planMode: !!plan,
        },
      });
    } finally {
      releaseConductor();
    }

    if (!conductorResult.ok) {
      recordConductorTurnDecision(conductorResult, false);
      return streamConductorAnswer({
        chatId: id,
        messages,
        alias: conductorResult.conductorAlias,
        answer: localInferenceUnavailableAnswer(`Conductor routing failed: ${conductorResult.failureReason}`),
        reason: "conductor routing failed; streamed local-only failure",
      });
    }

    const explicitModelOverride = isExplicitModelOverride(chosenModel, conductorResult);
    forcedModelAlias = explicitModelOverride ? chosenModel : undefined;
    if (conductorResult.decision.action === "answer") {
      if (!explicitModelOverride && !requestedComputer) {
        recordConductorTurnDecision(conductorResult, true);
        return streamConductorAnswer({
          chatId: id,
          messages,
          alias: conductorResult.conductorAlias,
          answer: conductorResult.decision.answer,
          reason: "conductor direct answer",
        });
      }
      recordConductorTurnDecision(conductorResult, false, requestedComputer ? "computer intent bypassed direct answer" : "selected model override");
    } else {
      const route = conductorResult.decision.route;
      conductorRoute = route && explicitModelOverride && chosenModel ? { ...route, alias: chosenModel } : route;
      recordConductorTurnDecision(conductorResult, false);
    }
  }

  // The FULL registry — used for message validation; `streamText` gets the filtered set.
  // Capability tools (search_graph, ha_*, remember/recall, tasks, photos, image, feed) now
  // arrive via `leashMcpTools()` from the toggleable leash-tools-mcp groups, not in-process.
  const baseTools = { ...leashTools, ...(await leashMcpTools()) };
  const baseBrokers = buildCapabilityBrokers(baseTools);
  // Plan mode (`submit_plan`): built unconditionally so stored plan-mode threads validate on any
  // turn; only handed to the AGENT when this turn is in plan mode (below). `getTask`/`getWriter` are
  // getters because the tool is built before the task text + response writer exist; `execute` (which
  // uses them) runs only after approval, by which point both are set.
  const planId = createIdGenerator({ prefix: "plan", size: 16 })();
  const goalRunId = createIdGenerator({ prefix: "run", size: 16 })();
  const planStream: { writer?: { write: (part: unknown) => void } } = {};
  let planTask = "";
  let activeModelForRun = "";
  // The plan pipeline halts BETWEEN steps when the client stopped (`req.signal`) OR a follow-up is
  // waiting to interject — this gate decides whether the NEXT step launches. An in-flight decode is
  // now also cancelled on `req.signal` via the agent's abortSignal (safe on the current 0.13.x SDK line); interject still
  // halts cleanly between steps rather than mid-decode so the queued follow-up runs on a clean turn.
  const planTool = buildPlanTool({
    registry: baseTools,
    getTask: () => planTask,
    getWriter: () => planStream.writer,
    getAbort: () => req.signal.aborted || interjectRequested(id),
    planId,
    getRunId: () => goalRunId,
    getModel: () => activeModelForRun || undefined,
  });
  // `run_skill` delegates a sub-task to another skill as a sub-agent (multi-skill orchestration —
  // see skill-runner.ts). It delegates FROM the base registry (no nesting on itself). Plugin agents
  // each become their own callable sub-agent tool (agent-runner.ts) — enabled-plugin-only, capped.
  const tools = { ...baseTools, ...baseBrokers, ...buildSkillRunner(baseTools), ...buildAgentTools((await listAgents()).filter((a) => a.enabled), baseTools), ...planTool, ...KEEPALIVE_TOOLS };

  // Validate stored+new messages against current tool/metadata schemas; fall back to raw on drift.
  let validated: LeashUIMessage[] = messages;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validated = (await validateUIMessages({
      messages,
      tools: tools as any,
      metadataSchema,
      dataSchemas: { skill: skillDataSchema, plan: planDataSchema, conductor: conductorDataSchema, goalRun: goalRunDataSchema },
    })) as LeashUIMessage[];
  } catch (err) {
    console.error("leash: UI message validation failed, using raw history:", err);
  }

  // Load the built-in agent base (leash.md): body = default chat prompt, model = default alias.
  // Synchronous; falls back to CHAT_SYSTEM_PROMPT + "" on any failure.
  const base = loadMainAgentBase();

  // Routing: image turn -> vision VLM; else computer-use intent (while any computer tool is
  // enabled) -> computer driver; else conductor-ranked text capability (chat/health/etc.).
  const off = await disabledTools();
  const imageTurn = isImageTurn(validated);
  // Computer/Files live in toggleable MCP servers: a lane is available only when its tools are
  // present in the merged registry this turn and not disabled.
  const available = new Set(Object.keys(baseTools));
  const computerEnabled = [...COMPUTER_TOOL_NAMES].some((name) => available.has(name) && !off.has(name));
  // Files (sandboxed retrieval) takes precedence over computer for read/search intents.
  const filesEnabled = [...BASH_TOOL_NAMES].some((name) => available.has(name) && !off.has(name));
  const filesTurn = !imageTurn && filesEnabled && isFilesIntent(validated);
  const computerTurn = !imageTurn && !filesTurn && computerEnabled && isComputerIntent(validated);
  // The model actually driving this turn (for telemetry) — chat uses the user-chosen alias, else the
  // configured default; not a hardcoded last-resort alias.
  // Conductor: for the generalist chat lane (not image/computer) we run the Conductor to pick
  // the best available route (local vs. peer). Specialist routes keep their dedicated models — the
  // Conductor only overrides the generalist chat model selection.
  const suggestedAlias = conductorRoute?.alias;
  const defaultAlias = forcedModelAlias ?? suggestedAlias ?? (base.model || resolvedChatAlias());
  let conductorDecision: ConductorRouteDecision;
  let conductorEffortTier: EffortTier | null = null;
  try {
    const allConductorOptions = await fetchRouteOptions();
    if (!allConductorOptions.length) {
      return streamConductorAnswer({
        chatId: id,
        messages,
        alias: "local-qvac",
        answer: localInferenceUnavailableAnswer("No live local or mesh QVAC routes are available"),
        reason: "no live qvac routes; streamed local-only failure",
      });
    }
    const conductorOptions = forcedModelAlias ? allConductorOptions.filter((o) => o.alias === forcedModelAlias) : allConductorOptions;
    if (forcedModelAlias && !conductorOptions.length) {
      return routeFailure(409, `Requested route alias "${forcedModelAlias}" is not live on this device or any visible mesh peer; refusing to fallback.`, {
        liveAliases: allConductorOptions.map((o) => `${o.alias}@${o.tier}`),
      });
    }
    const preclassified = conductorRoute
      ? { bar: capabilityBarFromConductorRoute(conductorRoute), sensitivity: conductorRoute.sensitivity, reason: conductorRoute.reason }
      : undefined;
    const publicBlock = preclassified ? publicMeshRouteBlocked({ bar: preclassified.bar, sensitivity: preclassified.sensitivity, options: conductorOptions }) : null;
    if (publicBlock && preclassified) {
      const answer =
        "I found a public mesh model that may fit this request, but the turn looks private. I won't send Apple Notes, files, memory, health, finance, credentials, or device-specific context to the public mesh. Use a local/private mesh model, or re-ask with only shareable context if you want public paid delegation.";
      conductorAudit.record({
        event: "note",
        modelId: publicBlock.alias,
        extra: {
          role: "conductor",
          phase: "public-mesh-blocked",
          sensitivity: preclassified.sensitivity,
          bar: preclassified.bar,
          reason: publicBlock.reason,
        },
      });
      return streamConductorAnswer({ chatId: id, messages, alias: publicBlock.alias, answer, reason: `public mesh blocked for private turn: ${publicBlock.reason}` });
    }
    if (preclassified) {
      conductorDecision = rankConductorRoute({
        bar: preclassified.bar,
        sensitivity: preclassified.sensitivity,
        options: conductorOptions,
        reason: preclassified.reason,
      });
    } else {
      conductorEffortTier = imageTurn ? null : await classifyEffort(lastUserText(validated));
      const guardedBar = barFromGuardedTurn({
        tier: conductorEffortTier ?? "standard",
        isImageTurn: imageTurn,
        text: lastUserText(validated),
      });
      if (conductorEffortTier === "quick" && !imageTurn && guardedBar.specialist !== "health") {
        const local = pickLocalGeneral(conductorOptions, defaultAlias);
        conductorDecision = {
          modality: "text",
          sensitivity: "private",
          bar: { modality: "text", minParamClass: "small" },
          route: { tier: "device", alias: local.alias },
          reason: "fast-path: trivial turn -> local",
          viaFastPath: true,
        };
      } else {
        conductorDecision = rankConductorRoute({
          bar: guardedBar,
          sensitivity: "private",
          options: conductorOptions,
        });
      }
    }
  } catch (err) {
    console.error("leash[conductor]: error while ranking route options; refusing fallback:", err);
    return streamConductorAnswer({
      chatId: id,
      messages,
      alias: "local-qvac",
      answer: localInferenceUnavailableAnswer(`Routing failed before the model call: ${err instanceof Error ? err.message : String(err)}`),
      reason: "route ranking failed; streamed local-only failure",
    });
  }
  console.log(`leash[conductor]: route=${conductorDecision.route.tier}/${conductorDecision.route.alias} sensitivity=${conductorDecision.sensitivity} reason="${conductorDecision.reason}"`);
  // Audit record — skip fast-path trivial turns to avoid noise; delegation events are always logged.
  if (!conductorDecision.viaFastPath) {
    try {
      conductorAudit.record({
        event: conductorDecision.route.peerKey ? "delegation" : "note",
        modelId: conductorDecision.route.alias,
        ...(conductorDecision.route.modelSrc ? { modelSrc: conductorDecision.route.modelSrc } : {}),
        extra: {
          tier: conductorDecision.route.tier,
          peerKey: conductorDecision.route.peerKey ?? null,
          sensitivity: conductorDecision.sensitivity,
          bar: conductorDecision.bar,
          reason: conductorDecision.reason,
        },
      });
    } catch {
      /* audit write must never break a turn */
    }
  }
  // Vision hard-rule: image turns ALWAYS use the vision VLM regardless of the Conductor decision.
  // Computer keeps its dedicated model. Health remains a text capability with a task prompt.
  const activeModel = imageTurn ? VISION_MODEL : computerTurn ? COMPUTER_MODEL : conductorDecision.route.alias || defaultAlias;
  activeModelForRun = activeModel;
  const healthTurn = !imageTurn && !filesTurn && !computerTurn && conductorDecision.bar.specialist === "health";
  // When the Conductor picked a peer route, build a routedChatModel that carries the body directive
  // so the hypha shim places the turn on the correct peer. Otherwise use the standard local chatModel.
  const conductorModel =
    !imageTurn && !filesTurn && !computerTurn && conductorDecision.route.peerKey
      ? routedChatModel({ alias: activeModel, sensitivity: conductorDecision.sensitivity, ...(conductorDecision.route.meshId ? { meshId: conductorDecision.route.meshId } : {}), peerKey: conductorDecision.route.peerKey })
      : undefined;

  // Plan mode (user toggle): the GENERALIST chat turn becomes plan-then-execute. The model's only
  // job is to call `submit_plan` (approval-gated → the Plan card); on approval its `execute` runs the
  // steps through the deterministic pipeline. Restricted to the plain chat turn — image/files/computer/health
  // carry their own specialized toolsets/prompts, and a skill `steps:` pipeline (below) is a
  // deterministic workflow already, so plan mode stands down for those.
  const planMode = !!plan && !imageTurn && !filesTurn && !computerTurn && !healthTurn;

  // Dynamic effort: grade each non-image turn (text + voice) into a tier and derive its params
  // (tools on/off, step cap, `/no_think`, token ceiling). A spoken turn must answer in seconds,
  // so voice always runs `/no_think`; text keeps full `<think>` reasoning on the `deep` tier.
  // Image turns are unchanged (the VLM handles one image-grounded turn, no tools/no /no_think).
  const tier = imageTurn ? null : (conductorEffortTier ?? (await classifyEffort(lastUserText(validated))));
  const cfg = tier ? effortConfig(tier, !!voice) : null;
  const useNoThink = !!cfg?.noThink;

  // Prompts come from the store (dashboard override ?? code default; mtime-cached reads),
  // plus the skills section ("" when no skills — honest empty state).
  const lastText = lastUserText(validated);
  planTask = lastText; // the overall task each approved plan step is executed against
  const [systemPrompt, healthPrompt, skillsSection, activeSkills, prefs, constitution] = await Promise.all([
    getPrompt("chat", base.body),
    healthTurn ? getPrompt("health") : Promise.resolve(""),
    skillsSystemSection(),
    activeSkillsSection(lastText),
    preferenceTexts(),
    getConstitution(),
  ]);
  const baseSystem = systemPrompt;
  // The constitution (soul + goals) makes EVERY turn goal-aware, not just heartbeats. Bounded by the
  // store's per-file cap. Trimmed so an unedited/empty file contributes nothing to the prompt.
  const soulSection = buildSoulSection(constitution.soul);
  const goalsSection = buildGoalsSection(constitution.goals);
  // Always advertise the skill catalog — even with a skill already active — so the model can
  // ORCHESTRATE: discover and load OTHER skills mid-flow with read_skill (multi-skill workflows).
  // When a skill is auto-active its body is already injected (activeSkills.section); the catalog
  // here lets the model reach the rest.
  const availableSkillsSection = skillsSection;
  // Progressive tool disclosure: an active skill's declared `tools:` become the EXACT
  // toolset for this turn (agent.ts honors `skillTools`, overriding the route default).
  const declaredSkillTools = activeSkills?.tools ?? [];
  // `preference` memories steer behavior on EVERY turn (other memory types are
  // retrieval-only via recall/search_graph). Bounded: newest 20.
  const prefSection = buildPreferenceSection(prefs);

  // Tool toggles apply at streamText (not at validation): old threads must still
  // validate against the full registry even when a tool they used is now disabled.
  // Approval gates ("Ask first") read config at call time — a toggle applies next turn.
  // Approval gates + disabled-tool filtering apply to the registry the AGENT holds;
  // the per-turn FOCUSED TOOLSET (computer turns activate only the Open Computer Use tools —
  // 28 offered schemas overflow the serve's 4096-token prompt and hang the decode,
  // verified 2026-06-07) is `activeTools` in the agent's prepareCall (agent.ts).
  // Plan mode restricts the AGENT to just `submit_plan` (already approval-gated) so the 4B is forced
  // to plan first; the approved steps execute against the FULL registry inside the tool. Otherwise
  // the normal enabled/approval-gated toolset — with `submit_plan` EXCLUDED (it's in `tools` only so
  // stored plan-mode threads validate; offering it every turn would invite spurious plans + eat the
  // serve's 4096-token tool budget).
  const agentTools = Object.fromEntries(Object.entries(tools).filter(([n]) => n !== "submit_plan"));
  const enabledTools = planMode ? planTool : await filterEnabledTools(agentTools);
  // Tell the model about its computer-use powers only when they're actually active —
  // naming them every turn invites hallucinated <tool_call>s for absent tools.
  const computerNote = computerTurn ? CHAT_COMPUTER_MODE_NOTE : "";
  // Files turn: name the sandboxed retrieval tool so the model reaches for bash (grep/find/cat/jq)
  // over the user's files. It's a read-only in-memory snapshot — no approval, can't touch the disk.
  const filesNote = filesTurn ? CHAT_FILES_MODE_NOTE : "";
  // The (possibly overridden) system prompt may still NAME disabled tools — tell the
  // model they're gone, or it text-hallucinates <tool_call> blocks for them.
  // (`off` was read above for the computer-turn routing.)
  const disabledNote = buildDisabledToolsNote(off);
  // Some tool calls pause on a human approval card. A DENIED call must not be retried —
  // acknowledge the refusal and move on (without this, small models loop the same call).
  const approvalNote = CHAT_APPROVAL_NOTE;
  // Thinking-budget cap (SmallCode port): on reasoning-ON turns (deep text), qwen3-4b can burn its
  // whole token budget on <think> and emit no answer. Steer it to reason briefly so the answer fits
  // (paired with the raised deep-tier token budget in effort.ts). Only when not /no_think and not vision.
  const thinkingNote =
    !useNoThink && !imageTurn
      ? CHAT_THINKING_NOTE
      : "";
  // Plan mode: the model's ONE job is to draft a plan via submit_plan; the user approves it and the
  // harness runs each step. After the steps run, present their combined result as your final answer.
  const planNote = planMode ? CHAT_PLAN_MODE_NOTE : "";
  // Inline citations (graceful): when grounding an answer in retrieved sources, the model MAY tag
  // facts with [1], [2], … numbered in the order it first used them — the UI turns valid markers into
  // source pills. Optional, so it never forces behavior on a turn with no sources.
  const citeNote =
    !imageTurn && !computerTurn
      ? CHAT_CITATION_NOTE
      : "";

  // Context compaction (text turns only): when the thread outgrows the model's window,
  // summarize the oldest messages into a stored running summary and send only
  // [summary + recent tail] to the model. The FULL history stays in `validated` →
  // `originalMessages` → saved/displayed; only the model's input shrinks. Image turns
  // are single-shot, so they skip this. Best-effort: failure falls back to full history.
  // Tracks qwen3-4b's `ctx_size` in qvac.config.base.json (32768 since 2026-06-12, qwen3-4b's
  // native window — the serve's own default is a tiny 1024; agent turns carry 2-4k of tool
  // schemas + system prompt before history even starts). Keep the two in sync.
  const CTX = Number(process.env["LEASH_CHAT_CTX"] ?? 32768);
  let modelMessages = validated;
  let summarySection = "";
  if (!imageTurn) {
    const c = await compact(id, validated, CTX, { summary: record?.summary, summarizedThrough: record?.summarizedThrough });
    if (c.tailFrom > 0 && c.tailFrom < validated.length) modelMessages = validated.slice(c.tailFrom);
    if (c.summary) summarySection = buildSummarySection(c.summary, c.tailFrom);
  }

  // On voice turns (non-image), append the spoken-output directive so the model answers in short,
  // markdown-free prose — Supertonic reads raw markdown literally. Text and image turns are unchanged.
  const system = [baseSystem, healthPrompt, summarySection, soulSection, goalsSection, prefSection, activeSkills?.section ?? "", availableSkillsSection, computerNote, filesNote, disabledNote, approvalNote, thinkingNote, citeNote, planNote, voice && !imageTurn ? await getPrompt("voice") : "", useNoThink ? NO_THINK_DIRECTIVE : ""]
    .filter(Boolean)
    .join(" ");

  // Count this generation as in-flight so the dashboard's serve stop/restart refuses
  // while the serve is decoding (aborting/killing mid-generation wedges the GPU).
  const release = beginGeneration();

  // DETERMINISTIC-WORKFLOW turn: when the matched skill declares an ordered `steps:` plan, DRIVE it as
  // a pipeline (skill-runner.ts) instead of a free-run agent loop — the harness owns the step order, so
  // the 4B does one atomic sub-task per step and can't drop a dependent step (verified 2026-06-12:
  // pipeline 3/3 vs free-run ~1/3 on a dependent chain). The pipeline uses the skill's own declared
  // tools (approval-gated ones are skipped, like run_skill). Text turns only; image turns never match here.
  const pipeline = !imageTurn && !planMode ? activeSkills?.pipeline ?? null : null;
  const callRoute: LeashCallOptions["route"] = imageTurn ? "vision" : filesTurn ? "files" : computerTurn ? "computer" : healthTurn ? "health" : "chat";
  const runRoute: ToolRoute = pipeline ? "skill" : planMode ? "plan" : callRoute;
  const directFileFinder =
    !imageTurn &&
    !planMode &&
    !pipeline &&
    activeSkills?.skills.some((s) => s.slug === "file-finder") === true &&
    shouldRunFileFinderFastPath(lastText) &&
    typeof (enabledTools as Record<string, unknown>)["bash"] === "object";
  const goalRun = await createGoalRun({
    id: goalRunId,
    chatId: id,
    title: lastText || "Leash turn",
    route: runRoute,
    sensitivity: conductorDecision.sensitivity,
    ...(record?.summary ? { contextSummary: record.summary } : {}),
  });
  if (pipeline) {
    let unsubscribePipe: (() => void) | undefined;
    const pipeStream = createUIMessageStream<LeashUIMessage>({
      originalMessages: validated,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      execute: async ({ writer }) => {
        writer.write({ type: "message-metadata", messageMetadata: { createdAt: Date.now(), model: activeModel, ...(tier ? { effort: tier } : {}) } });
        writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(goalRun) });
        unsubscribePipe = subscribeElicitations((ev) => {
          try {
            writer.write({ type: "data-elicitation", data: ev, transient: true });
          } catch {
            /* stream already closed */
          }
        });
        writer.write({ type: "data-conductor", data: { tier: conductorDecision.route.tier, alias: conductorDecision.route.alias, ...(conductorDecision.route.peerKey ? { peerKey: conductorDecision.route.peerKey } : {}), ...(conductorDecision.route.meshId ? { meshId: conductorDecision.route.meshId } : {}), reason: conductorDecision.reason, viaFastPath: conductorDecision.viaFastPath } });
        writer.write({ type: "data-skill", data: { mode: activeSkills?.mode ?? "automatic", skills: activeSkills?.skills ?? [{ slug: pipeline.slug, name: pipeline.slug }] } });
        let text: string;
        try {
          const out = await runSkillAsPipeline(pipeline.slug, lastText, baseTools, { goalRunId });
          text = out.text;
          await finishGoalRun(goalRunId, "completed", text);
        } catch (e) {
          text = `The "${pipeline.slug}" workflow couldn't finish: ${e instanceof Error ? e.message : String(e)}`;
          await appendGoalRunError(goalRunId, text);
          await finishGoalRun(goalRunId, "failed", text);
        } finally {
          const finalRun = await getGoalRun(goalRunId);
          if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
          release();
        }
        const tid = "pipeline-out";
        writer.write({ type: "text-start", id: tid });
        writer.write({ type: "text-delta", id: tid, delta: text });
        writer.write({ type: "text-end", id: tid });
        writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
      },
      onFinish: ({ messages: finalMessages }) => {
        unsubscribePipe?.();
        release(); // idempotent
        void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
      },
    });
    return createUIMessageStreamResponse({ stream: pipeStream });
  }

  if (directFileFinder) {
    let unsubscribeFileFinder: (() => void) | undefined;
    const fileFinderStream = createUIMessageStream<LeashUIMessage>({
      originalMessages: validated,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      execute: async ({ writer }) => {
        writer.write({ type: "message-metadata", messageMetadata: { createdAt: Date.now(), model: "bash", ...(tier ? { effort: tier } : {}) } });
        writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(goalRun) });
        unsubscribeFileFinder = subscribeElicitations((ev) => {
          try {
            writer.write({ type: "data-elicitation", data: ev, transient: true });
          } catch {
            /* stream already closed */
          }
        });
        writer.write({ type: "data-conductor", data: { tier: conductorDecision.route.tier, alias: conductorDecision.route.alias, ...(conductorDecision.route.peerKey ? { peerKey: conductorDecision.route.peerKey } : {}), ...(conductorDecision.route.meshId ? { meshId: conductorDecision.route.meshId } : {}), reason: conductorDecision.reason, viaFastPath: true } });
        writer.write({ type: "data-skill", data: { mode: activeSkills?.mode ?? "automatic", skills: activeSkills?.skills ?? [{ slug: "file-finder", name: "file-finder" }] } });
        const mainStep = await startGoalRunStep(goalRunId, {
          title: "Search local files",
          route: "skill",
          model: "bash",
          contextCapsule: lastText.slice(0, 6000),
          contextTokensEstimate: Math.ceil(lastText.length / 4),
        });
        let text: string;
        try {
          const out = await runFileFinderFastPath(lastText, enabledTools);
          text = out?.text.trim() || "No matching local file results were found.";
          await updateGoalRunStep(goalRunId, mainStep.id, { status: "done", summary: text.slice(0, 1200) });
          await finishGoalRun(goalRunId, "completed", text);
        } catch (e) {
          text = `The file-finder fast path failed: ${e instanceof Error ? e.message : String(e)}`;
          await updateGoalRunStep(goalRunId, mainStep.id, { status: "failed", error: text });
          await appendGoalRunError(goalRunId, text);
          await finishGoalRun(goalRunId, "failed", text);
        } finally {
          const finalRun = await getGoalRun(goalRunId);
          if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
          release();
        }
        const tid = "file-finder-out";
        writer.write({ type: "text-start", id: tid });
        writer.write({ type: "text-delta", id: tid, delta: text });
        writer.write({ type: "text-end", id: tid });
        writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
      },
      onFinish: ({ messages: finalMessages }) => {
        unsubscribeFileFinder?.();
        release();
        void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
      },
    });
    return createUIMessageStreamResponse({ stream: fileFinderStream });
  }

  // NOTE on serve-side kvCache: the forked serve accepts a `kv_cache` body field (see
  // patches/@qvac+cli) and hypha's shim caches delegated sessions — but THIS route does
  // not send a key. Every text tier runs tools-ON (the TOOLLESS-HANG guard in effort.ts),
  // and custom-key kv reuse across tool-call turns is unverified SDK territory; a wrong
  // count-state silently corrupts answers. Hypha-only by design — see the README.
  // Qwen3 best practice: historical assistant output must NOT carry its `<think>` reasoning — it
  // bloats context and degrades performance. Strip reasoning parts from the MODEL input only; the
  // stored/displayed thread keeps them (originalMessages = `validated`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noReasoning = modelMessages.map((m: any) => (m.role === "assistant" && Array.isArray(m.parts) ? { ...m, parts: m.parts.filter((p: any) => p?.type !== "reasoning") } : m));
  // Fold NON-IMAGE file attachments (markdown, code, JSON, CSV, logs…) into the model input as
  // text so the text-only chat model can actually read them; images are left as file parts for
  // the vision route. Stored/displayed thread (`validated`) is untouched — it keeps the file chip.
  const withFiles = inlineFileAttachments(noReasoning);
  const modelInput = await convertToModelMessages(withFiles);

  // The Leash agent (ToolLoopAgent, agent.ts): typed call options carry this turn's
  // derived context; `prepareCall` maps them to model / activeTools / steps / tokens.
  // CANCEL-ON-DISCONNECT: we pass the client request's `abortSignal` (`req.signal`).
  // On Stop / client disconnect the AI SDK aborts the fetch to the qvac serve, whose
  // cancel-bridge (`@qvac/cli` `bindClientDisconnectCancel`, armed by `req.bindCancel`
  // on every completion) fires `cancel({ requestId })` — the decode stops and the GPU
  // frees immediately. This was historically withheld (verified 2026-06-05: one aborted
  // request wedged every later generation) because the 0.11-era engine wedged on a
  // mid-decode cancel; the current 0.13.x SDK line cancels safely (spike/abort-safety-inproc.ts), so it
  // is now re-enabled. The partial answer still persists: `createUIMessageStream`'s
  // onFinish fires on abort with the streamed-so-far messages → `saveChat`.
  const laneBudget = deriveLaneBudget({ imageTurn, planMode, filesTurn, computerTurn, declaredSkillTools, cfg });
  const callOptions: LeashCallOptions = {
    route: callRoute,
    // Vision turns are single-shot: no tool loop, no step cap, and NO token ceiling
    // (qwen3vl breaks on max_tokens — see computer-tools.ts). A skill-driven toolset gets
    // the most steps; else computer/files get their raised budgets, else the effort tier's.
    steps: laneBudget.steps,
    maxOutputTokens: laneBudget.maxOutputTokens,
    ...(declaredSkillTools.length ? { skillTools: declaredSkillTools } : {}),
    ...(laneBudget.leanTools && callRoute === "chat" ? { leanTools: true } : {}),
    // Thinking ON ⇒ Qwen3 thinking-mode sampling; /no_think ⇒ non-thinking sampling (agent.ts).
    thinking: !imageTurn && !useNoThink,
    // Text-route model alias chosen by the conductor or explicit picker.
    // Vision/computer routes use their dedicated model factories in agent.ts.
    ...(!imageTurn && !computerTurn ? { model: activeModel } : {}),
    system,
  };
  const runBeforeStep = (await getGoalRun(goalRunId)) ?? goalRun;
  const capsule = buildContextCapsule({
    run: runBeforeStep,
    currentStep: "Answer the user's latest turn with the selected route and allowed tools.",
    relevantContext: [lastText, summarySection].filter(Boolean),
    maxChars: 6000,
  });
  const mainStep = await startGoalRunStep(goalRunId, {
    title: planMode ? "Draft and run approved plan" : "Answer user turn",
    route: runRoute,
    model: activeModel,
    contextCapsule: capsule.text,
    contextTokensEstimate: capsule.tokenEstimate,
  });
  const policyContext = {
    route: planMode ? "chat" : callRoute,
    runId: goalRunId,
    stepId: mainStep.id,
    publicMesh: conductorDecision.route.tier === "public",
  } satisfies Parameters<typeof enforceToolPolicy>[1];
  const policyTools = enforceToolPolicy(enabledTools, policyContext);
  const directBrokerCall = callRoute === "chat" && !planMode && !pipeline ? directBrokerCallForSimpleTurn(lastText) : null;
  const directBrokerTool = directBrokerCall ? (policyTools as Record<string, { execute?: unknown }>)[directBrokerCall.broker] : undefined;
  if (directBrokerCall && typeof directBrokerTool?.execute === "function") {
    const directBrokerStream = createUIMessageStream<LeashUIMessage>({
      originalMessages: validated,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      execute: async ({ writer }) => {
        writer.write({ type: "message-metadata", messageMetadata: { createdAt: Date.now(), model: directBrokerCall.broker, ...(tier ? { effort: tier } : {}) } });
        writer.write({ type: "data-conductor", data: { tier: conductorDecision.route.tier, alias: directBrokerCall.broker, ...(conductorDecision.route.peerKey ? { peerKey: conductorDecision.route.peerKey } : {}), ...(conductorDecision.route.meshId ? { meshId: conductorDecision.route.meshId } : {}), reason: `deterministic broker fast path: ${directBrokerCall.action}`, viaFastPath: true } });
        const runNow = await getGoalRun(goalRunId);
        if (runNow) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(runNow) });
        if (activeSkills?.skills.length) writer.write({ type: "data-skill", data: { mode: activeSkills.mode, skills: activeSkills.skills } });

        let text: string;
        try {
          const out = await runDirectBrokerCall(directBrokerCall, policyTools as ToolSet);
          if (out === null) throw new Error(`${directBrokerCall.broker} unavailable`);
          text = out || "(no output)";
          await updateGoalRunStep(goalRunId, mainStep.id, { status: "done", summary: text.slice(0, 1200) });
          await finishGoalRun(goalRunId, "completed", text);
        } catch (e) {
          text = `The broker fast path failed: ${e instanceof Error ? e.message : String(e)}`;
          await updateGoalRunStep(goalRunId, mainStep.id, { status: "failed", error: text });
          await appendGoalRunError(goalRunId, text);
          await finishGoalRun(goalRunId, "failed", text);
        } finally {
          const finalRun = await getGoalRun(goalRunId);
          if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
          release();
        }

        writer.write({ type: "text-start", id: "direct-broker-out" });
        writer.write({ type: "text-delta", id: "direct-broker-out", delta: text });
        writer.write({ type: "text-end", id: "direct-broker-out" });
        writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
      },
      onFinish: ({ messages: finalMessages }) => {
        release();
        void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
      },
    });
    return createUIMessageStreamResponse({ stream: directBrokerStream });
  }
  const directBashCommand = callRoute === "files" && !planMode && !pipeline ? directBashCommandForSimpleTurn(lastText) : null;
  const directBashTool = directBashCommand ? (policyTools as Record<string, { execute?: unknown }>)["bash"] : undefined;
  if (directBashCommand && typeof directBashTool?.execute === "function") {
    const directBashStream = createUIMessageStream<LeashUIMessage>({
      originalMessages: validated,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      execute: async ({ writer }) => {
        writer.write({ type: "message-metadata", messageMetadata: { createdAt: Date.now(), model: "bash", ...(tier ? { effort: tier } : {}) } });
        writer.write({ type: "data-conductor", data: { tier: conductorDecision.route.tier, alias: "bash", ...(conductorDecision.route.peerKey ? { peerKey: conductorDecision.route.peerKey } : {}), ...(conductorDecision.route.meshId ? { meshId: conductorDecision.route.meshId } : {}), reason: "deterministic bash command fast path", viaFastPath: true } });
        const runNow = await getGoalRun(goalRunId);
        if (runNow) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(runNow) });
        if (activeSkills?.skills.length) writer.write({ type: "data-skill", data: { mode: activeSkills.mode, skills: activeSkills.skills } });

        let text: string;
        try {
          const out = await runDirectBashCommand(directBashCommand, policyTools as ToolSet);
          if (out === null) throw new Error("bash tool unavailable");
          text = out || "(no output)";
          await updateGoalRunStep(goalRunId, mainStep.id, { status: "done", summary: text.slice(0, 1200) });
          await finishGoalRun(goalRunId, "completed", text);
        } catch (e) {
          text = `The bash fast path failed: ${e instanceof Error ? e.message : String(e)}`;
          await updateGoalRunStep(goalRunId, mainStep.id, { status: "failed", error: text });
          await appendGoalRunError(goalRunId, text);
          await finishGoalRun(goalRunId, "failed", text);
        } finally {
          const finalRun = await getGoalRun(goalRunId);
          if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
          release();
        }

        writer.write({ type: "text-start", id: "direct-bash-out" });
        writer.write({ type: "text-delta", id: "direct-bash-out", delta: text });
        writer.write({ type: "text-end", id: "direct-bash-out" });
        writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
      },
      onFinish: ({ messages: finalMessages }) => {
        release();
        void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
      },
    });
    return createUIMessageStreamResponse({ stream: directBashStream });
  }
  const brokeredPolicyTools = planMode ? policyTools : { ...policyTools, ...buildCapabilityBrokers(policyTools) };
  const approvedTools = planMode ? brokeredPolicyTools : withApprovalGates(brokeredPolicyTools);
  const agent = buildLeashAgent(approvedTools, () => interjectRequested(id), conductorModel);
  const result = await agent.stream({ messages: modelInput, options: callOptions, abortSignal: req.signal });

  // Drive the stream server-side so persistence still runs if the client stops reading mid-token.
  // `then(release, release)` ALWAYS fires once the run settles — success, error, or abort (on Stop,
  // consumeStream rejects with the abort error, which `release` handles). The decode itself is
  // stopped by the serve's cancel-bridge (see the cancel-on-disconnect note above), not drained.
  void result.consumeStream().then(release, release);

  // Wrap the model stream so out-of-band MCP elicitation events (server→user forms, see
  // elicitations.ts) ride this same SSE response as TRANSIENT data parts — they reach
  // `useChat`'s onData but are never persisted into the message. On abort the same
  // consumeStream→release path runs and onFinish still persists the partial via
  // `originalMessages` message-id reuse.
  let unsubscribe: (() => void) | undefined;
  const stream = createUIMessageStream<LeashUIMessage>({
    originalMessages: validated,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: async ({ writer }) => {
      // Plan-mode `submit_plan.execute` streams `data-plan` step status through this writer.
      planStream.writer = writer as unknown as { write: (part: unknown) => void };
      unsubscribe = subscribeElicitations((ev) => {
        try {
          writer.write({ type: "data-elicitation", data: ev, transient: true });
        } catch {
          /* stream already closed — the GET /elicitations fallback covers reloads */
        }
      });
      // Conductor decision — always emitted (even fast-path) so the UI has the route context.
      writer.write({ type: "data-conductor", data: { tier: conductorDecision.route.tier, alias: conductorDecision.route.alias, ...(conductorDecision.route.peerKey ? { peerKey: conductorDecision.route.peerKey } : {}), ...(conductorDecision.route.meshId ? { meshId: conductorDecision.route.meshId } : {}), reason: conductorDecision.reason, viaFastPath: conductorDecision.viaFastPath } });
      const runNow = await getGoalRun(goalRunId);
      if (runNow) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(runNow) });
      if (activeSkills?.skills.length) {
        writer.write({
          type: "data-skill",
          data: { mode: activeSkills.mode, skills: activeSkills.skills },
        });
      }
      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          messageMetadata: ({ part }) => {
            if (part.type === "start") return { createdAt: Date.now(), model: activeModel, ...(tier ? { effort: tier } : {}) };
            if (part.type === "finish") return { finishedAt: Date.now(), totalTokens: part.totalUsage?.totalTokens };
            return undefined;
          },
          onError: (error) => {
            release();
            const message = error instanceof Error ? error.message : String(error);
            void updateGoalRunStep(goalRunId, mainStep.id, { status: "failed", error: message });
            void appendGoalRunError(goalRunId, message);
            void finishGoalRun(goalRunId, "failed", message);
            return message;
          },
        }),
      );
      // Stream-tail quality guards (SmallCode quality-monitor ports). Best-effort — a throw here
      // must never break the response.
      try {
        const finalText = ((await result.text) ?? "").trim();
        const appendText = (id: string, text: string): void => {
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: text });
          writer.write({ type: "text-end", id });
        };
        const approvalFallback = !finalText ? await pendingApprovalFallback(result) : null;
        const emptyFallback = !finalText && !planMode && !approvalFallback ? await emptyTurnFallback(result) : "";
        const finalSummary = approvalFallback ?? (planMode && !finalText ? "Plan proposed; waiting for user approval." : finalText || emptyFallback);
        const finalStatus = approvalFallback || (planMode && !finalText) ? "paused" : finalText ? "completed" : "failed";
        await updateGoalRunStep(goalRunId, mainStep.id, {
          status: finalStatus === "failed" ? "failed" : "done",
          summary: finalSummary,
          ...(finalStatus === "failed" ? { error: "model produced no final answer text" } : {}),
        });
        if (finalStatus === "failed") await appendGoalRunError(goalRunId, "model produced no final answer text");
        await finishGoalRun(goalRunId, finalStatus, finalSummary);
        await recordGoalRunModelTrace(goalRunId, {
          stepId: mainStep.id,
          model: activeModel,
          alias: conductorDecision.route.alias,
          routeTier: conductorDecision.route.tier,
          ...(conductorDecision.route.peerKey ? { peerKey: conductorDecision.route.peerKey } : {}),
          startedAt: mainStep.startedAt ?? Date.now(),
          finishedAt: Date.now(),
          contextTokensEstimate: capsule.tokenEstimate,
          reason: conductorDecision.reason,
        });
        const finalRun = await getGoalRun(goalRunId);
        if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
        if (!finalText) {
          // Empty turn: the model emitted no answer (often after burning its budget on <think>).
          if (emptyFallback) appendText("empty-turn-fallback", emptyFallback);
        } else {
          // Tool-call-as-text: the model wrote a tool call into its answer instead of invoking it.
          // Log it (to measure frequency) and add an honest nudge after the stray text.
          const tc = toolCallAsText(finalText);
          if (tc.matched) {
            console.warn(`leash: model emitted a tool call as TEXT${tc.toolName ? ` (${tc.toolName})` : ""} — route=${callOptions.route}, len=${finalText.length}`);
            appendText("toolcall-text-note", "\n\n_(I wrote that as text instead of actually running the tool — ask me to try again and I'll invoke it for real.)_");
          }
        }
      } catch (e) {
        const message = req.signal.aborted ? "cancelled" : e instanceof Error ? e.message : "stream-tail guard failed";
        await updateGoalRunStep(goalRunId, mainStep.id, { status: req.signal.aborted ? "cancelled" : "failed", error: message });
        await appendGoalRunError(goalRunId, message);
        await finishGoalRun(goalRunId, req.signal.aborted ? "cancelled" : "failed", message);
        const finalRun = await getGoalRun(goalRunId);
        if (finalRun) writer.write({ type: "data-goalRun", id: goalRunId, data: goalRunView(finalRun) });
      }
    },
    onFinish: ({ messages: finalMessages }) => {
      unsubscribe?.();
      release(); // idempotent belt-and-braces alongside consumeStream().finally
      void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
