/**
 * Live multi-turn showcase conversation for Leash.
 *
 * Drives the real authenticated /api/leash/chat route through a long conversation that
 * exercises broker tools, first-class subagents, context growth, and compaction evidence.
 *
 * To force compaction in a demo run, start web with a small context budget, for example:
 *   LEASH_CHAT_CTX=1800 LEASH_COMPACT_FRACTION=0.35 npm run web:dev
 *
 * Requirements:
 * - Leash web listening on LEASH_WEB_BASE (default http://127.0.0.1:6801)
 * - QVAC serve reachable by the web app
 * - LEASH_COOKIE or /tmp/leash-cookie.txt containing a valid leash_session
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");
const TURN_TIMEOUT_MS = Number(process.env["LEASH_SHOWCASE_TURN_TIMEOUT_MS"] ?? 6 * 60_000);
const FILLER_TURNS = Math.max(0, Math.min(20, Number(process.env["LEASH_SHOWCASE_FILLER_TURNS"] ?? 6)));
const EXPECT_COMPACTION = process.env["LEASH_SHOWCASE_EXPECT_COMPACTION"] === "1";
const ONLY_SCENARIO = process.env["LEASH_SHOWCASE_ONLY_SCENARIO"]?.trim();
const TERMINAL = new Set(["completed", "failed", "paused", "cancelled"]);
const BROKER_TOOL_NAMES = new Set(["context_run", "memory_run", "tasks_run", "files_run", "mcp_run"]);

export interface ShowcaseTurn {
  scenario: string;
  text: string;
  expect: string[];
}

interface StreamEvent {
  type?: string;
  id?: string;
  data?: unknown;
  toolName?: string;
  messageMetadata?: unknown;
}

interface GoalRunData {
  id: string;
  chatId?: string;
  status: string;
  route: string;
  steps: Array<{ status: string; title: string; model?: string; summary?: string; error?: string }>;
  errors: string[];
  finalSynthesis?: string;
}

interface GoalRunRecord {
  id: string;
  steps: Array<{ status: string; title: string; route?: string; model?: string; summary?: string; contextCapsule?: string; contextTokensEstimate?: number }>;
}

interface ChatRecord {
  id: string;
  messages: unknown[];
  summary?: string;
  summarizedThrough?: number;
}

interface AgentContextEvidence {
  agent: string;
  tokenEstimate: number;
  contextChars: number;
  hasDelegatedTask: boolean;
  hasParentCapsule: boolean;
  hasLatestTurn: boolean;
  hasToolList: boolean;
  summaryHead: string;
}

interface TurnResult {
  turn: number;
  scenario: string;
  durationMs: number;
  finalRun: GoalRunData;
  tools: string[];
  agents: string[];
  agentContextEvidence: AgentContextEvidence[];
  eventTypes: string[];
  bodyHead: string;
}

export function buildShowcaseTurns(input: { marker: string; fillerTurns?: number }): ShowcaseTurn[] {
  const fillerTurns = Math.max(0, input.fillerTurns ?? FILLER_TURNS);
  const turns: ShowcaseTurn[] = [
    {
      scenario: "opening-marker",
      text: `Turn marker: 1. Answer directly: marker 1 starts the run. Demo marker ${input.marker}.`,
      expect: [],
    },
    {
      scenario: "context-broker",
      text: `Use context-grounding to search for Leash tool broker or context bloat notes. Demo marker ${input.marker}. Answer in one tight sentence.`,
      expect: ["context_run"],
    },
    {
      scenario: "memory-broker",
      text: `Use memory-keeper to recall preferred answer length. Demo marker ${input.marker}. Answer compactly.`,
      expect: ["memory_run"],
    },
    {
      scenario: "tasks-broker",
      text: `Use task-manager to list open tasks only. Demo marker ${input.marker}. Do not create or update tasks.`,
      expect: ["tasks_run"],
    },
    {
      scenario: "grace-coder-agent",
      text: `Ask Grace/coder subagent to judge whether progressive tool disclosure is safer than exposing every tool. Demo marker ${input.marker}. Return the bottom line.`,
      expect: ["agent__coder"],
    },
    {
      scenario: "bree-summary-agent",
      text: `Can Bree summarize this conversation so far into one paragraph? Demo marker ${input.marker}.`,
      expect: ["agent__summarizer"],
    },
  ];

  for (let i = 0; i < fillerTurns; i++) {
    const turn = turns.length + 1;
    const prior = turn - 1;
    turns.push({
      scenario: `long-context-${i + 1}`,
      text: `Turn marker: ${turn}. Answer directly: marker ${turn} followed marker ${prior}. Demo marker ${input.marker}.`,
      expect: [],
    });
  }

  turns.push({
    scenario: "final-continuity-check",
    text: [
      `Final continuity check for demo marker ${input.marker}.`,
      "Use context-grounding if useful, then summarize the conversation's orchestration evidence:",
      "which broker tools were used, which subagents were delegated to, and whether earlier continuity markers are still represented.",
      "Keep it under 120 words.",
    ].join(" "),
    expect: ["context_run"],
  });

  return turns;
}

async function cookieHeader(): Promise<string> {
  if (process.env["LEASH_COOKIE"]) return process.env["LEASH_COOKIE"];
  return (await readFile("/tmp/leash-cookie.txt", "utf8")).trim();
}

function parseSse(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n+/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as StreamEvent);
    } catch {
      events.push({ type: "parse-error", data });
    }
  }
  return events;
}

function collectToolNames(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  const direct = obj["toolName"];
  if (typeof direct === "string") out.add(direct);
  for (const child of Object.values(obj)) collectToolNames(child, out);
  return out;
}

function collectRunToolNames(run: GoalRunData): string[] {
  const out = new Set<string>();
  for (const step of run.steps ?? []) {
    if (step.model === "bash") out.add("bash");
    if (step.model && BROKER_TOOL_NAMES.has(step.model)) out.add(step.model);
    if (/search local files/i.test(step.title)) out.add("files_run");
    if (typeof step.model === "string" && step.model.startsWith("agent__")) out.add(step.model);
  }
  return [...out];
}

function leashDataDir(): string {
  if (process.env["LEASH_DATA_DIR"]) return process.env["LEASH_DATA_DIR"];
  const leashBase = join(process.env["LEASH_BASE"] ?? homedir(), "Leash");
  let userId = "_bootstrap";
  try {
    const active = JSON.parse(existsSync(join(leashBase, "active.json")) ? readFileSync(join(leashBase, "active.json"), "utf8") : "{}") as { userId?: string | null };
    if (active.userId) userId = active.userId;
  } catch {
    /* bootstrap fallback */
  }
  return join(leashBase, userId, "data");
}

function goalRunsPath(): string {
  return process.env["LEASH_GOAL_RUNS_FILE"] ?? join(leashDataDir(), "leash-goal-runs.json");
}

async function readGoalRunRecord(runId: string): Promise<GoalRunRecord | null> {
  try {
    const raw = JSON.parse(await readFile(goalRunsPath(), "utf8")) as GoalRunRecord[];
    return raw.find((run) => run.id === runId) ?? null;
  } catch {
    return null;
  }
}

function agentContextEvidence(record: GoalRunRecord | null): AgentContextEvidence[] {
  return (record?.steps ?? [])
    .filter((step) => step.route === "agent" || step.model?.startsWith("agent__"))
    .map((step) => {
      const context = step.contextCapsule ?? "";
      return {
        agent: step.model ?? step.title,
        tokenEstimate: step.contextTokensEstimate ?? 0,
        contextChars: context.length,
        hasDelegatedTask: /Delegated task:/i.test(context),
        hasParentCapsule: /Parent run capsule:/i.test(context),
        hasLatestTurn: /Latest user turn:/i.test(context),
        hasToolList: /Selected subagent tools:/i.test(context),
        summaryHead: context.slice(0, 500),
      };
    });
}

function finalRunFrom(events: StreamEvent[], chatId: string, messageId: string): GoalRunData {
  const runs = events.filter((e) => e.type === "data-goalRun").map((e) => e.data as GoalRunData);
  if (runs.length > 0) return runs[runs.length - 1]!;
  const conductor = events.find((e) => e.type === "data-conductor")?.data as { alias?: string; tier?: string; route?: string } | undefined;
  return {
    id: messageId,
    chatId,
    status: "completed",
    route: conductor?.route ?? conductor?.alias ?? conductor?.tier ?? "direct",
    steps: [],
    errors: [],
  };
}

async function postChat(input: { chatId: string; messageId: string; text: string; cookie: string }): Promise<TurnResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS);
  try {
    const res = await fetch(`${WEB_BASE}/api/leash/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: input.cookie },
      signal: controller.signal,
      body: JSON.stringify({
        id: input.chatId,
        trigger: "submit-message",
        message: {
          id: input.messageId,
          role: "user",
          parts: [{ type: "text", text: input.text }],
        },
      }),
    });
    const body = await res.text();
    assert.equal(res.ok, true, `/api/leash/chat returned ${res.status}: ${body.slice(0, 1200)}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "chat response must be an SSE UI message stream");
    const events = parseSse(body);
    assert.ok(events.some((e) => e.type === "data-conductor"), "chat stream emitted a conductor route decision");
    assert.ok(events.some((e) => e.type === "finish" || e.type === "message-metadata"), "chat stream emitted finish metadata");
    const finalRun = finalRunFrom(events, input.chatId, input.messageId);
    const ledgerRun = await readGoalRunRecord(finalRun.id);
    assert.equal(finalRun.chatId, input.chatId, "goal run binds to the chat id");
    assert.ok(TERMINAL.has(finalRun.status), `goal run did not reach terminal status: ${finalRun.status}`);
    assert.notEqual(finalRun.status, "failed", `chat run failed: ${finalRun.errors.join("; ") || finalRun.finalSynthesis || "unknown failure"}`);
    const tools = [...new Set([...collectToolNames(events), ...collectRunToolNames(finalRun)])].sort();
    return {
      turn: Number(input.messageId.split("-").at(-1) ?? 0),
      scenario: "",
      durationMs: Date.now() - started,
      finalRun,
      tools,
      agents: tools.filter((toolName) => toolName.startsWith("agent__")),
      agentContextEvidence: agentContextEvidence(ledgerRun),
      eventTypes: [...new Set(events.map((e) => e.type).filter(Boolean))].sort() as string[],
      bodyHead: body.slice(0, 3000),
    };
  } finally {
    clearTimeout(timer);
  }
}

function chatRecordPath(chatId: string): string {
  const explicit = process.env["LEASH_CHAT_RECORD_DIR"] ?? process.env["LEASH_CHAT_DIR"];
  if (explicit) return join(explicit, `${chatId}.json`);
  return join(leashDataDir(), "leash-chats", `${chatId}.json`);
}

async function readChatRecord(chatId: string): Promise<{ path: string; record: ChatRecord | null }> {
  const path = chatRecordPath(chatId);
  try {
    return { path, record: JSON.parse(await readFile(path, "utf8")) as ChatRecord };
  } catch {
    return { path, record: null };
  }
}

async function main(): Promise<void> {
  const cookie = await cookieHeader();
  assert.ok(cookie.includes("leash_session="), "set LEASH_COOKIE or create /tmp/leash-cookie.txt with a valid Leash session");

  const active = await fetch(`${WEB_BASE}/api/leash/auth/active`);
  assert.equal(active.ok, true, "web app auth probe is reachable");

  const suffix = Date.now().toString(36);
  const marker = `multi-orch-${suffix}`;
  const chatId = `codex-multiorch-showcase-${suffix}`;
  const allTurns = buildShowcaseTurns({ marker, fillerTurns: FILLER_TURNS });
  const turns = ONLY_SCENARIO ? allTurns.filter((turn) => turn.scenario === ONLY_SCENARIO) : allTurns;
  assert.ok(turns.length > 0, `unknown LEASH_SHOWCASE_ONLY_SCENARIO: ${ONLY_SCENARIO}`);
  const results: TurnResult[] = [];
  const allTools = new Set<string>();
  const allAgents = new Set<string>();
  const reportDir = join(process.cwd(), "logs");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `showcase-multiorchestration-chat-${suffix}.json`);

  async function writeReport(ok: boolean, error?: unknown): Promise<void> {
    const chat = await readChatRecord(chatId);
    const report = {
      ok,
      chatId,
      marker,
      expectedTurns: turns.length,
      completedTurns: results.length,
      tools: [...allTools].sort(),
      agents: [...allAgents].sort(),
      agentContextEvidence: results.flatMap((result) => result.agentContextEvidence),
      compaction: {
        recordPath: chat.path,
        messageCount: chat.record?.messages.length ?? 0,
        summarizedThrough: chat.record?.summarizedThrough ?? 0,
        summaryChars: chat.record?.summary?.length ?? 0,
        summaryHead: chat.record?.summary?.slice(0, 600) ?? "",
      },
      turns: results,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error ? String(error) : undefined,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  try {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      process.stderr.write(`turn ${i + 1}/${turns.length} ${turn.scenario} ... `);
      const result = await postChat({
        chatId,
        messageId: `msg-${suffix}-${i + 1}`,
        cookie,
        text: turn.text,
      });
      result.scenario = turn.scenario;
      for (const tool of result.tools) allTools.add(tool);
      for (const agent of result.agents) allAgents.add(agent);
      results.push(result);
      await writeReport(false);
      process.stderr.write(`${result.finalRun.route}/${result.finalRun.status} tools=${result.tools.join(",") || "-"} dur=${result.durationMs}ms\n`);
    }

    const expected = new Set(turns.flatMap((turn) => turn.expect));
    for (const toolName of expected) assert.ok(allTools.has(toolName), `expected showcase tool evidence for ${toolName}; saw ${[...allTools].sort().join(",") || "none"}`);
    if (!ONLY_SCENARIO || turns.some((turn) => turn.expect.includes("agent__coder"))) assert.ok(allAgents.has("agent__coder"), "Grace/coder subagent was not used");
    if (!ONLY_SCENARIO || turns.some((turn) => turn.expect.includes("agent__summarizer"))) assert.ok(allAgents.has("agent__summarizer"), "Bree/summarizer subagent was not used");
    const agentPackets = results.flatMap((result) => result.agentContextEvidence);
    for (const agentName of ["agent__coder", "agent__summarizer"].filter((name) => !ONLY_SCENARIO || turns.some((turn) => turn.expect.includes(name)))) {
      const packet = agentPackets.find((entry) => entry.agent === agentName);
      assert.ok(packet, `${agentName} did not record a durable agent context packet`);
      assert.ok(packet.contextChars > 0, `${agentName} agent context packet is empty`);
      assert.ok(packet.tokenEstimate > 0, `${agentName} agent context token estimate missing`);
      assert.ok(packet.hasDelegatedTask, `${agentName} context packet missing delegated task`);
      assert.ok(packet.hasParentCapsule, `${agentName} context packet missing parent run capsule`);
      assert.ok(packet.hasLatestTurn, `${agentName} context packet missing latest user turn`);
      assert.ok(packet.hasToolList, `${agentName} context packet missing selected subagent tools`);
    }

    const chat = await readChatRecord(chatId);
    assert.ok(chat.record, `stored chat record not found at ${chat.path}`);
    assert.equal(chat.record!.messages.length, turns.length * 2, "stored chat kept every user and assistant message");
    if (EXPECT_COMPACTION) {
      assert.ok((chat.record!.summarizedThrough ?? 0) > 0, "expected compaction summarizedThrough > 0");
      assert.ok((chat.record!.summary?.length ?? 0) > 0, "expected compaction summary text");
    }

    await writeReport(true);
    console.log(JSON.stringify({ ok: true, chatId, marker, reportPath, tools: [...allTools].sort(), agents: [...allAgents].sort(), compaction: { summarizedThrough: chat.record!.summarizedThrough ?? 0, summaryChars: chat.record!.summary?.length ?? 0 } }, null, 2));
    console.log("showcase:multiorchestration-chat PASS");
  } catch (error) {
    await writeReport(false, error);
    console.error(`showcase report: ${reportPath}`);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
