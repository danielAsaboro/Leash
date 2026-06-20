import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");

interface StreamEvent {
  type: string;
  data?: unknown;
  toolName?: string;
  finishReason?: string;
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

const cookie = await cookieHeader();
assert.ok(cookie.includes("leash_session="), "set LEASH_COOKIE or /tmp/leash-cookie.txt");

const suffix = Date.now().toString(36);
const started = Date.now();
const res = await fetch(`${WEB_BASE}/api/leash/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    id: `codex-file-finder-probe-${suffix}`,
    trigger: "submit-message",
    message: {
      id: `msg-file-finder-probe-${suffix}`,
      role: "user",
      parts: [
        {
          type: "text",
          text: "Use the file-finder skill from chat. Search my local files for where Leash MCP builtins are defined, then answer with the best matching file path only.",
        },
      ],
    },
  }),
});

const body = await res.text();
const durationMs = Date.now() - started;
assert.equal(res.ok, true, `/api/leash/chat returned ${res.status}: ${body.slice(0, 1200)}`);

const events = parseSse(body);
const conductor = events.find((e) => e.type === "data-conductor")?.data;
const skills = new Set<string>();
const tools = new Set<string>();
for (const event of events) {
  if (event.toolName) tools.add(event.toolName);
  if (event.type === "data-skill") {
    const data = event.data as { skills?: Array<{ slug: string }> };
    for (const skill of data.skills ?? []) skills.add(skill.slug);
  }
}

assert.ok(events.some((e) => e.type === "finish" || e.type === "message-metadata"), "chat stream finished");
assert.ok(skills.has("file-finder"), "chat selected file-finder");

console.log(JSON.stringify({ ok: true, durationMs, conductor, skills: [...skills].sort(), tools: [...tools].sort() }, null, 2));
