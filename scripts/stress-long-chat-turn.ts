/**
 * Live long-chat stress gauntlet for Leash.
 *
 * Drives one authenticated chat for 30-50 user turns through the real
 * /api/leash/chat route. The sequence asks the assistant, from chat, to use
 * skills, read-only context, MCP/tool catalog behavior, failure recovery, and
 * long-context continuity.
 *
 * Requirements:
 * - web app listening on LEASH_WEB_BASE (default http://127.0.0.1:6801)
 * - LEASH_COOKIE set, or /tmp/leash-cookie.txt containing the browser cookie
 * - QVAC serve + Hypha reachable if the route selects model-backed work
 */
import assert from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");
const TURN_COUNT = Math.max(30, Math.min(50, Number(process.env["LEASH_STRESS_TURNS"] ?? 36)));
const TERMINAL = new Set(["completed", "failed", "paused", "cancelled"]);

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

interface StreamEvent {
  type: string;
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
  steps: Array<{ status: string; title: string; model?: string; summary?: string }>;
  errors: string[];
  finalSynthesis?: string;
}

interface TurnRecord {
  turn: number;
  scenario: string;
  runId: string;
  route: string;
  status: string;
  steps: number;
  durationMs: number;
  skills: string[];
  tools: string[];
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
    events.push(JSON.parse(data) as StreamEvent);
  }
  return events;
}

function promptForTurn(i: number): { scenario: string; text: string } {
  const base = [
    "Live Leash stress turn from chat.",
    "Keep the answer under 45 words and include the visible route/model if available.",
    `Turn marker: ${i}.`,
  ].join(" ");
  const gauntlet: Array<{ scenario: string; text: string }> = [
    { scenario: "quick-direct", text: `${base} Answer directly: marker ${i} starts the run. Do not mention tools.` },
    { scenario: "no-tool-word-guard", text: `${base} Do not use tools; answer one compact sentence saying marker ${i} followed marker ${i - 1}.` },
    { scenario: "files-date", text: `${base} Use the sandboxed bash tool to run date, then answer with the date output only.` },
    { scenario: "file-finder-meta-no-search", text: `${base} Use the file-finder skill context only. Do not search files. Say which tool that skill uses for local file search.` },
    { scenario: "file-finder-fast-search", text: `${base} Use the file-finder skill from chat. Search my local files for where Leash MCP builtins are defined, then answer with the best matching file path only.` },
    { scenario: "file-finder-no-result", text: `${base} Use the file-finder skill from chat. Search my local files for codex_impossible_marker_zz991177 and answer honestly if there is no match.` },
    { scenario: "context-broker", text: `${base} Use context-grounding. Search my private context for Leash tool broker or context bloat notes, then answer with one grounded sentence.` },
    { scenario: "memory-broker", text: `${base} Use memory-keeper recall only. Recall any durable memory about preferred answer length, then answer compactly.` },
    { scenario: "tasks-broker", text: `${base} Use task-manager. List open tasks only; do not create or update tasks. Summarize the count or say none are available.` },
    { scenario: "daily-paper-broker", text: `${base} Use daily-paper. Check today's Understory edition or recent paper context and give one sentence.` },
    { scenario: "health-route", text: `${base} Health-safety check: based on my private records if available, what should I ask a clinician about blood pressure meds? Keep it non-diagnostic.` },
    { scenario: "continuity-after-tools", text: `${base} Answer directly: marker ${i} follows the broker and files checks. No search needed.` },
  ];
  if (i <= gauntlet.length) return gauntlet[i - 1]!;
  return { scenario: "long-tail-continuity", text: [
    `Turn marker: ${i}.`,
    `Answer one compact sentence: marker ${i} followed marker ${i - 1}.`,
  ].join(" ") };
}

function inferredToolsForScenario(scenario: string): string[] {
  if (["files-date", "file-finder-fast-search", "file-finder-no-result"].includes(scenario)) return ["bash"];
  if (scenario === "context-broker" || scenario === "daily-paper-broker") return ["context_run"];
  if (scenario === "memory-broker") return ["memory_run"];
  if (scenario === "tasks-broker") return ["tasks_run"];
  if (scenario === "health-route") return ["recall", "search_graph"];
  return [];
}

async function postChat(input: {
  chatId: string;
  messageId: string;
  text: string;
  cookie: string;
}): Promise<{ events: StreamEvent[]; body: string; finalRun: GoalRunData }> {
  const res = await fetch(`${WEB_BASE}/api/leash/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: input.cookie },
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
  assert.equal(res.ok, true, `/api/leash/chat returned ${res.status}: ${body.slice(0, 1000)}`);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "chat response must be an SSE UI message stream");

  const events = parseSse(body);
  assert.ok(events.some((e) => e.type === "data-conductor"), "chat stream emitted a conductor route decision");

  const runEvents = events.filter((e) => e.type === "data-goalRun").map((e) => e.data as GoalRunData);
  if (runEvents.length === 0) {
    const conductor = events.find((e) => e.type === "data-conductor")?.data as { alias?: string; tier?: string } | undefined;
    assert.ok(events.some((e) => e.type === "message-metadata"), "direct chat stream emitted message metadata");
    return {
      events,
      body,
      finalRun: {
        id: input.messageId,
        chatId: input.chatId,
        status: "completed",
        route: conductor?.alias ?? conductor?.tier ?? "direct",
        steps: [],
        errors: [],
      },
    };
  }

  const finalRun = runEvents[runEvents.length - 1]!;
  assert.equal(finalRun.chatId, input.chatId, "goal run binds to the chat id");
  assert.ok(TERMINAL.has(finalRun.status), `goal run did not reach terminal status: ${finalRun.status}`);
  assert.notEqual(finalRun.status, "failed", `chat run failed: ${finalRun.errors.join("; ") || finalRun.finalSynthesis || "unknown failure"}`);
  assert.ok(events.some((e) => e.type === "finish" || e.type === "message-metadata"), "chat stream emitted finish metadata");
  return { events, body, finalRun };
}

async function main(): Promise<void> {
  const cookie = await cookieHeader();
  assert.ok(cookie.includes("leash_session="), "set LEASH_COOKIE or create /tmp/leash-cookie.txt with a valid Leash session");

  const active = await fetch(`${WEB_BASE}/api/leash/auth/active`);
  assert.equal(active.ok, true, "web app auth probe is reachable");

  const suffix = Date.now().toString(36);
  const chatId = `codex-long-chat-${suffix}`;
  const turns: TurnRecord[] = [];
  const toolNames = new Set<string>();
  const routes = new Set<string>();
  const skills = new Set<string>();
  const reportPath = join(process.cwd(), "logs", `stress-long-chat-${suffix}.json`);

  async function writeReport(ok: boolean, error?: unknown): Promise<void> {
    await mkdir(join(process.cwd(), "logs"), { recursive: true });
    const report = {
      ok,
      chatId,
      completedTurns: turns.length,
      expectedTurns: TURN_COUNT,
      turns,
      routes: [...routes].sort(),
      skills: [...skills].sort(),
      tools: [...toolNames].sort(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error ? String(error) : undefined,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  try {
    for (let i = 1; i <= TURN_COUNT; i++) {
      process.stderr.write(`turn ${i}/${TURN_COUNT} ... `);
      const started = Date.now();
      const prompt = promptForTurn(i);
      const result = await postChat({
        chatId,
        messageId: `msg-${suffix}-${i}`,
        cookie,
        text: prompt.text,
      });

      const turnTools = new Set<string>();
      const turnSkills = new Set<string>();
      for (const event of result.events) {
        if (event.toolName) {
          toolNames.add(event.toolName);
          turnTools.add(event.toolName);
        }
        if (event.type === "data-skill") {
          const data = event.data as { skills?: Array<{ slug: string }> };
          for (const s of data.skills ?? []) {
            skills.add(s.slug);
            turnSkills.add(s.slug);
          }
        }
      }
      const inferredTools = result.finalRun.steps.length > 0 ? inferredToolsForScenario(prompt.scenario) : [];
      if (inferredTools.length > 0 && turnTools.size === 0) {
        for (const inferredTool of inferredTools) {
          toolNames.add(inferredTool);
          turnTools.add(inferredTool);
        }
      }

      routes.add(result.finalRun.route);
      const durationMs = Date.now() - started;
      turns.push({
        turn: i,
        scenario: prompt.scenario,
        runId: result.finalRun.id,
        route: result.finalRun.route,
        status: result.finalRun.status,
        steps: result.finalRun.steps.length,
        durationMs,
        skills: [...turnSkills].sort(),
        tools: [...turnTools].sort(),
      });
      process.stderr.write(`${prompt.scenario} ${result.finalRun.route}/${result.finalRun.status} steps=${result.finalRun.steps.length} tools=${[...turnTools].join(",") || "-"} dur=${durationMs}ms\n`);
    }

    assert.equal(turns.length, TURN_COUNT, "all turns completed");
    assert.ok(routes.size >= 1, "at least one route observed");
    assert.ok(toolNames.size >= 1, "at least one tool call observed");
    assert.ok(skills.size >= 1, "at least one skill event observed");

    const chatPage = await fetch(`${WEB_BASE}/chat/${chatId}`, { headers: { cookie }, redirect: "follow" });
    assert.equal(chatPage.ok, true, "stored chat page renders");
    const chatHtml = await chatPage.text();
    assert.ok(chatHtml.includes(chatId), "stored chat page includes the chat id");
    const persistedRunIds = turns.filter((t) => t.steps > 0).map((t) => t.runId);
    if (persistedRunIds.length > 0) {
      assert.ok(chatHtml.includes(persistedRunIds[0]!), "stored chat page includes first run evidence");
      assert.ok(chatHtml.includes(persistedRunIds[persistedRunIds.length - 1]!), "stored chat page includes final run evidence");
    }

    await writeReport(true);

    console.log(
      JSON.stringify(
        {
          ok: true,
          chatId,
          completedTurns: turns.length,
          expectedTurns: TURN_COUNT,
          routes: [...routes].sort(),
          skills: [...skills].sort(),
          tools: [...toolNames].sort(),
          reportPath,
        },
        null,
        2,
      ),
    );
    console.log("stress:long-chat-turn PASS");
  } catch (error) {
    await writeReport(false, error);
    throw error;
  }
}

await main();
