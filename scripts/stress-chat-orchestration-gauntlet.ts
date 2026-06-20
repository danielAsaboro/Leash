/**
 * Live user-path orchestration gauntlet.
 *
 * This is the acceptance path for orchestration: it drives the authenticated
 * /api/leash/chat endpoint, then verifies the stored chat page and Tasks/Runs page.
 * Unit scripts are useful, but they are not the product path users exercise.
 *
 * Requirements:
 * - web app listening on LEASH_WEB_BASE (default http://127.0.0.1:6801)
 * - QVAC serve + Hypha reachable if the route needs them
 * - LEASH_COOKIE set, or /tmp/leash-cookie.txt containing the browser cookie
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");
const TERMINAL = new Set(["completed", "failed", "paused", "cancelled"]);

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

async function cookieHeader(): Promise<string> {
  if (process.env["LEASH_COOKIE"]) return process.env["LEASH_COOKIE"];
  const txt = await readFile("/tmp/leash-cookie.txt", "utf8").catch(() => "");
  return txt.trim();
}

function parseSse(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of body.split(/\n\n+/)) {
    const data = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data) as StreamEvent);
  }
  return events;
}

async function get(path: string, cookie: string): Promise<string> {
  const res = await fetch(`${WEB_BASE}${path}`, { headers: { cookie }, redirect: "follow" });
  assert.equal(res.ok, true, `${path} returned ${res.status}`);
  return res.text();
}

async function postChat(input: { chatId: string; messageId: string; text: string; cookie: string }): Promise<{ events: StreamEvent[]; body: string; finalRun: GoalRunData }> {
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
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "chat response must be an SSE UI message stream");
  const body = await res.text();
  assert.equal(res.ok, true, `/api/leash/chat returned ${res.status}: ${body.slice(0, 500)}`);
  const events = parseSse(body);
  assert.ok(events.some((e) => e.type === "data-conductor"), "chat stream emitted a conductor route decision");
  const runEvents = events.filter((e) => e.type === "data-goalRun").map((e) => e.data as GoalRunData);
  assert.ok(runEvents.length > 0, "chat stream emitted a goal-run data part");
  const finalRun = runEvents[runEvents.length - 1]!;
  assert.equal(finalRun.chatId, input.chatId, "goal run binds to the chat id");
  assert.ok(TERMINAL.has(finalRun.status), `goal run did not reach terminal status: ${finalRun.status}`);
  assert.notEqual(finalRun.status, "failed", `chat run failed: ${finalRun.errors.join("; ") || finalRun.finalSynthesis || "unknown failure"}`);
  assert.ok(finalRun.steps.length >= 1, "goal run records at least one step");
  assert.ok(events.some((e) => e.type === "finish"), "chat stream emitted finish metadata");
  return { events, body, finalRun };
}

async function main(): Promise<void> {
  const cookie = await cookieHeader();
  assert.ok(cookie.includes("leash_session="), "set LEASH_COOKIE or create /tmp/leash-cookie.txt with a valid Leash session");

  const active = await fetch(`${WEB_BASE}/api/leash/auth/active`);
  assert.equal(active.ok, true, "web app auth probe is reachable");

  const suffix = Date.now().toString(36);
  const chatId = `codex-chat-gauntlet-${suffix}`;
  const first = await postChat({
    chatId,
    messageId: `msg-${suffix}-1`,
    cookie,
    text:
      "Live gauntlet through the normal Leash chat path. Use read-only context tools to search Apple Notes and private context for qvac, then answer in one sentence under 30 words with the visible route/model.",
  });

  const second = await postChat({
    chatId,
    messageId: `msg-${suffix}-2`,
    cookie,
    text:
      "Continue this same chat. Use read-only context if useful and answer in one sentence: did the previous turn persist a terminal goal-run status?",
  });

  const chatPage = await get(`/chat/${chatId}`, cookie);
  assert.ok(chatPage.includes(chatId), "stored chat page renders the chat id");
  assert.ok(chatPage.includes(first.finalRun.id), "stored chat page includes first run evidence");
  assert.ok(chatPage.includes(second.finalRun.id), "stored chat page includes second run evidence");
  assert.ok(chatPage.includes(first.finalRun.status), "stored chat page includes first terminal run status");
  assert.ok(chatPage.includes(second.finalRun.status), "stored chat page includes second terminal run status");

  const runsPage = await get(`/tasks?tab=runs&run=${second.finalRun.id}`, cookie);
  assert.ok(runsPage.includes(chatId), "Tasks/Runs links the run back to the chat");
  assert.ok(runsPage.includes(`${second.finalRun.status} · ${second.finalRun.route}`), "Tasks/Runs shows terminal run detail");

  const tools = [...new Set([...first.events, ...second.events].map((e) => e.toolName).filter((x): x is string => !!x))];
  console.log(
    JSON.stringify(
      {
        ok: true,
        chatId,
        firstRun: { id: first.finalRun.id, status: first.finalRun.status, route: first.finalRun.route, steps: first.finalRun.steps.length },
        secondRun: { id: second.finalRun.id, status: second.finalRun.status, route: second.finalRun.route, steps: second.finalRun.steps.length },
        tools,
      },
      null,
      2,
    ),
  );
  console.log("stress:chat-orchestration-gauntlet PASS");
}

await main();
