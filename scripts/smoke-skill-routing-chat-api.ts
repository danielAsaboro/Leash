/**
 * Smoke the real Leash HTTP chat path for skill routing.
 *
 * Requires:
 * - web app on LEASH_WEB_BASE (default http://127.0.0.1:6801)
 * - LEASH_COOKIE or /tmp/leash-cookie.txt with a valid `leash_session=...`
 *
 * The script reads only the early SSE route metadata. `/api/leash/chat` emits `data-skill`
 * before model output, so each case can abort after routing is observed.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");

interface SkillEvent {
  mode: "explicit" | "automatic";
  skills: Array<{ slug: string; name: string }>;
}

interface Case {
  name: string;
  text: string;
  expected: string | null;
}

const CASES: Case[] = [
  { name: "short greeting", text: "hi", expected: null },
  { name: "general small talk", text: "tell me a short joke", expected: null },
  { name: "computer", text: "look at my screen and tell me what app is open", expected: "computer-use" },
  { name: "context", text: "what did I decide about qvac in my notes?", expected: "context-grounding" },
  { name: "daily paper", text: "what's in my paper today?", expected: "daily-paper" },
  { name: "research", text: "what's the latest on the EU AI Act timeline?", expected: "deep-research" },
  { name: "file finder", text: "search my files for the function that parses the skill manifest", expected: "file-finder" },
  { name: "health metadata example", text: "I have chest pain and shortness of breath", expected: "health-safety" },
  { name: "image generation", text: "generate an image of a minimalist black coffee logo", expected: "image-generator" },
  { name: "mcp install", text: "install the GitHub MCP server from modelcontextprotocol/servers", expected: "mcp-installer" },
  { name: "memory", text: "remember that I prefer concise answers", expected: "memory-keeper" },
  { name: "photo finder", text: "find my photos with receipts in them", expected: "photo-finder" },
  { name: "smart home", text: "turn off the living room lights", expected: "smart-home" },
  { name: "task manager", text: "add a todo to renew the domain before Friday", expected: "task-manager" },
];

async function cookieHeader(): Promise<string> {
  if (process.env["LEASH_COOKIE"]) return process.env["LEASH_COOKIE"];
  return (await readFile("/tmp/leash-cookie.txt", "utf8")).trim();
}

function parseSseBlock(block: string): unknown | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  return JSON.parse(data) as unknown;
}

async function routeCase(input: Case, cookie: string): Promise<{ skill: SkillEvent | null; events: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const chatId = `codex-skill-route-${Date.now().toString(36)}-${input.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const events: string[] = [];
  let skill: SkillEvent | null = null;
  let sawGoalRun = false;
  let noSkillTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const res = await fetch(`${WEB_BASE}/api/leash/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      signal: controller.signal,
      body: JSON.stringify({
        id: chatId,
        trigger: "submit-message",
        message: { id: `${chatId}-user`, role: "user", parts: [{ type: "text", text: input.text }] },
      }),
    });
    if (!res.ok) throw new Error(`${input.name}: chat returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, `${input.name}: expected SSE response`);
    assert.ok(res.body, `${input.name}: missing response body`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.search(/\r?\n\r?\n/);
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(buffer[split] === "\r" ? split + 4 : split + 2);
        const parsed = parseSseBlock(block) as { type?: string; data?: unknown } | null;
        if (parsed?.type) events.push(parsed.type);
        if (parsed?.type === "data-skill") {
          skill = parsed.data as SkillEvent;
          controller.abort();
          return { skill, events };
        }
        if (parsed?.type === "data-goalRun" && !sawGoalRun) {
          sawGoalRun = true;
          noSkillTimer = setTimeout(() => controller.abort(), 250);
        }
        split = buffer.search(/\r?\n\r?\n/);
      }
    }
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timeout);
    if (noSkillTimer) clearTimeout(noSkillTimer);
  }
  return { skill, events };
}

async function main(): Promise<void> {
  const cookie = await cookieHeader();
  assert.ok(cookie.includes("leash_session="), "set LEASH_COOKIE or /tmp/leash-cookie.txt");
  const active = await fetch(`${WEB_BASE}/api/leash/auth/active`);
  assert.equal(active.ok, true, "web app must be reachable");

  const rows: Array<{ name: string; expected: string | null; actual: string | null; mode: string | null; events: string[] }> = [];
  for (const c of CASES) {
    process.stderr.write(`case: ${c.name} ... `);
    const routed = await routeCase(c, cookie);
    const actual = routed.skill?.skills[0]?.slug ?? null;
    rows.push({ name: c.name, expected: c.expected, actual, mode: routed.skill?.mode ?? null, events: routed.events });
    process.stderr.write(`${actual ?? "(none)"}\n`);
    assert.equal(actual, c.expected, `${c.name}: expected ${c.expected ?? "(none)"}, got ${actual ?? "(none)"}; events=${routed.events.join(",")}`);
  }

  console.log(JSON.stringify({ ok: true, base: WEB_BASE, rows }, null, 2));
  console.log("smoke:skill-routing-chat-api PASS");
}

await main();
