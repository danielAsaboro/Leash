/**
 * Live "clueless user" gauntlet for Leash.
 *
 * Drives the real authenticated /api/leash/chat route through multiple turns
 * that ask for real tool use, task/memory persistence, file/context lookup, and
 * specialist delegation. This is intentionally product-path, not a unit test.
 *
 * Requirements:
 * - Leash web listening on LEASH_WEB_BASE (default http://127.0.0.1:6801)
 * - qvac serve reachable by the web app
 * - LEASH_COOKIE or /tmp/leash-cookie.txt containing a valid leash_session
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");
const TURN_TIMEOUT_MS = Number(process.env["LEASH_GAUNTLET_TURN_TIMEOUT_MS"] ?? 8 * 60_000);
const TERMINAL = new Set(["completed", "failed", "paused", "cancelled"]);

interface StreamEvent {
  type?: string;
  id?: string;
  data?: unknown;
  toolName?: string;
  finishReason?: string;
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

interface TurnResult {
  turn: number;
  scenario: string;
  durationMs: number;
  events: StreamEvent[];
  bodyHead: string;
  finalRun: GoalRunData;
  toolNames: string[];
  agentToolNames: string[];
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

function collectRunToolNames(run: GoalRunData): string[] {
  const out = new Set<string>();
  for (const step of run.steps ?? []) {
    if (step.model === "bash") out.add("bash");
    if (/search local files/i.test(step.title)) out.add("files_run");
    if (typeof step.model === "string" && step.model.startsWith("agent__")) out.add(step.model);
  }
  return [...out];
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
    assert.equal(res.ok, true, `/api/leash/chat returned ${res.status}: ${body.slice(0, 1500)}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "chat response must be an SSE UI message stream");

    const events = parseSse(body);
    assert.ok(events.some((e) => e.type === "data-conductor"), "chat stream emitted a conductor route decision");
    assert.ok(events.some((e) => e.type === "finish" || e.type === "message-metadata"), "chat stream emitted finish metadata");

    const finalRun = finalRunFrom(events, input.chatId, input.messageId);
    assert.equal(finalRun.chatId, input.chatId, "goal run binds to the chat id");
    assert.ok(TERMINAL.has(finalRun.status), `goal run did not reach terminal status: ${finalRun.status}`);
    assert.notEqual(finalRun.status, "failed", `chat run failed: ${finalRun.errors.join("; ") || finalRun.finalSynthesis || "unknown failure"}`);

    const toolNames = [...new Set([...collectToolNames(events), ...collectRunToolNames(finalRun)])].sort();
    const agentToolNames = toolNames.filter((name) => name.startsWith("agent__"));
    return {
      turn: Number(input.messageId.split("-").at(-1) ?? 0),
      scenario: "",
      durationMs: Date.now() - started,
      events,
      bodyHead: body.slice(0, 4000),
      finalRun,
      toolNames,
      agentToolNames,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function get(path: string, cookie: string): Promise<string> {
  const res = await fetch(`${WEB_BASE}${path}`, { headers: { cookie }, redirect: "follow" });
  assert.equal(res.ok, true, `${path} returned ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const cookie = await cookieHeader();
  assert.ok(cookie.includes("leash_session="), "set LEASH_COOKIE or create /tmp/leash-cookie.txt with a valid Leash session");

  const active = await fetch(`${WEB_BASE}/api/leash/auth/active`);
  assert.equal(active.ok, true, "web app auth probe is reachable");

  const suffix = Date.now().toString(36);
  const marker = `clueless-${suffix}`;
  const chatId = `codex-clueless-gauntlet-${suffix}`;
  const prompts = [
    {
      scenario: "clueless-setup-tools",
      text: [
        "I don't know how this app works. Please actually use your tools.",
        `Run marker: ${marker}.`,
        "Remember this marker for this run, create a todo titled exactly",
        `"Gauntlet ${marker} verify Leash chat stack",`,
        "then use the files/local shell capability to inspect package.json and tell me which script starts the web app.",
        "Do not ask follow-up questions.",
      ].join(" "),
    },
    {
      scenario: "multi-turn-recall-and-delegate",
      text: [
        "Continue the same run.",
        `Recall the marker ${marker}, list my open todos to confirm the gauntlet todo exists,`,
        "search private context for QVAC or Leash testing notes,",
        "and delegate to the Grace/coder subagent to judge whether this repo has real orchestration tests.",
        "Answer with the tools/delegate you used and the bottom line.",
      ].join(" "),
    },
    {
      scenario: "specialist-summary",
      text: [
        "Now delegate to the Bree/summarizer subagent.",
        "Have Bree summarize what happened in this chat so far, including the marker, the task, and any evidence gathered.",
        "Keep the final answer short and include whether the specialist delegation actually happened.",
      ].join(" "),
    },
  ];

  const turns: TurnResult[] = [];
  const allTools = new Set<string>();
  const allAgentTools = new Set<string>();
  const reportDir = join(process.cwd(), "logs");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `gauntlet-clueless-chat-${suffix}.json`);

  async function writeReport(ok: boolean, error?: unknown): Promise<void> {
    const toolNames = [...allTools].sort();
    const agentToolNames = [...allAgentTools].sort();
    const report = {
      ok,
      chatId,
      marker,
      tools: toolNames,
      agentTools: agentToolNames,
      turns: turns.map((turn) => ({
        turn: turn.turn,
        scenario: turn.scenario,
        durationMs: turn.durationMs,
        run: {
          id: turn.finalRun.id,
          status: turn.finalRun.status,
          route: turn.finalRun.route,
          steps: turn.finalRun.steps,
          errors: turn.finalRun.errors,
          finalSynthesis: turn.finalRun.finalSynthesis,
        },
        tools: turn.toolNames,
        agentTools: turn.agentToolNames,
        eventTypes: [...new Set(turn.events.map((e) => e.type).filter(Boolean))].sort(),
        bodyHead: turn.bodyHead,
      })),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error ? String(error) : undefined,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  try {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i]!;
      process.stderr.write(`turn ${i + 1}/${prompts.length} ${prompt.scenario} ... `);
      const result = await postChat({
        chatId,
        messageId: `msg-${suffix}-${i + 1}`,
        cookie,
        text: prompt.text,
      });
      result.scenario = prompt.scenario;
      for (const name of result.toolNames) allTools.add(name);
      for (const name of result.agentToolNames) allAgentTools.add(name);
      turns.push(result);
      await writeReport(false);
      process.stderr.write(`${result.finalRun.route}/${result.finalRun.status} steps=${result.finalRun.steps.length} tools=${result.toolNames.join(",") || "-"} dur=${result.durationMs}ms\n`);
    }

    const chatPage = await get(`/chat/${chatId}`, cookie);
    assert.ok(chatPage.includes(chatId), "stored chat page includes the chat id");
    for (const turn of turns.filter((t) => t.finalRun.steps.length > 0)) {
      assert.ok(chatPage.includes(turn.finalRun.id), `stored chat page includes run ${turn.finalRun.id}`);
    }

    const toolNames = [...allTools].sort();
    const agentToolNames = [...allAgentTools].sort();

    assert.ok(toolNames.length >= 3, `expected at least 3 distinct tool calls across the chat, saw ${toolNames.join(",") || "none"}`);
    assert.ok(agentToolNames.length >= 1, `expected at least one subagent delegation tool call, saw tools: ${toolNames.join(",") || "none"}`);
    assert.ok(turns.some((t) => t.toolNames.some((name) => /tasks|create_task|list_task/i.test(name))), "expected a task tool/broker call");
    assert.ok(turns.some((t) => t.toolNames.some((name) => /memory|remember|recall/i.test(name))), "expected a memory tool/broker call");
    assert.ok(turns.some((t) => t.toolNames.some((name) => /files|bash/i.test(name))), "expected a files/bash tool/broker call");

    await writeReport(true);
    console.log(JSON.stringify({ ok: true, chatId, marker, tools: toolNames, agentTools: agentToolNames, reportPath }, null, 2));
    console.log("gauntlet:clueless-chat PASS");
  } catch (error) {
    await writeReport(false, error);
    console.error(`gauntlet report: ${reportPath}`);
    throw error;
  }
}

await main();
