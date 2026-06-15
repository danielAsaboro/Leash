/**
 * Spike (09) — Phase-0 de-risking for the mcp-cron scheduler migration.
 *
 * Verifies that `jolks/mcp-cron` (launched via `npx -y mcp-cron --transport stdio`)
 * behaves the way the migration plan (docs/superpowers/plans/2026-05-31… → 2026-06-15-mcp-cron-migration.md)
 * assumes, BEFORE any integration code is written. Drives the daemon over MCP stdio
 * with `@ai-sdk/mcp` — the exact transport + client Leash already uses (apps/web/lib/leash/mcp.ts).
 *
 * Load-bearing facts (PASS/FAIL logged per line; GO requires A–D + F):
 *   A. Tool inventory present.
 *   B. Shell task inherits the DAEMON's env + cwd  ← MAKE-OR-BREAK (the "scope env" approach).
 *   C. Cron expressions actually fire on schedule.
 *   D. SQLite path is honored (--db-path, not ~/.mcp-cron).
 *   E. HTTP task custom headers (informational — heartbeat uses a shell task, not this).
 *   F. add_ai_task errors with NO API key (never silently calls a cloud LLM — hard rule #1).
 *
 *   npm run spike:mcp-cron
 *
 * ── FINDINGS (run 2026-06-15, mcp-cron via `npx -y mcp-cron`, jolks build @ PR #23) ──
 *   GATE: GO ✅  (A, B, C, D, F all PASS; E PASS too).
 *   A. ✅ All 12 tools present (the 11 required + add_ai_task).
 *   B. ✅ MAKE-OR-BREAK CONFIRMED: a shell task INHERITS the daemon's env — the task
 *         saw SPIKE_MARKER exactly as exported to the mcp-cron process. cwd is also
 *         inherited (task cwd == the daemon's launch cwd). → The "scope env" approach
 *         works: set env + cwd on the ServiceDef (services.ts) and every task inherits
 *         it. No per-task env plumbing or wrapper-source needed.
 *   C. ✅ Cron fires: a `*/15 * * * * *` task ran 2× within the window. (6-field cron,
 *         seconds-first — robfig/cron/v3.)
 *   D. ✅ --db-path honored (db landed at /tmp/mcp-cron-spike.db; no ~/.mcp-cron created).
 *   E. ✅ HTTP tasks deliver custom headers (informational — heartbeat still uses a shell
 *         task, but add_http_task is a viable path for the agent-scheduling story).
 *   F. ✅ add_ai_task GUARD HOLDS: with no key it returns a clean failed-row, exit_code 1,
 *         error = "OpenAI API key is not set in configuration" — it ERRORS, never silently
 *         calls out. (Defaults to OpenAI. Still NEVER expose it — hard rule #1.)
 *
 *   ⚠ TWO BEHAVIORS THE PLAN MUST ACCOUNT FOR (carry into Tasks 2 & 4):
 *     1. add_task / add_http_task / add_ai_task create tasks DISABLED by default →
 *        you MUST call enable_task(id) after adding (or the task never runs and run_task
 *        rejects with "cannot run disabled task; enable it first"). cron-client.cronAdd
 *        must enable after add; map our `enabled` flag onto an explicit enable/disable.
 *     2. get_task_result THROWS "resource not found" when a task has no result rows yet
 *        (not an empty list). schedules-store.cronResults / cronRuns must catch and
 *        return [] so a never-fired schedule shows an empty (not errored) history.
 *
 *   ⚠ COSMETIC: on stdio client close the daemon prints `panic: close of closed channel`
 *      (server.go:191/197 shutdown race). Harmless here (post-test), but under supervision
 *      the daemon should be long-lived + stopped via forceStopService; don't treat a
 *      non-zero exit-on-close as a health failure. (Candidate one-line fix in our fork.)
 * ────────────────────────────────────────────────────────────────────────────────────
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import type { ToolSet } from "ai";

const DB_PATH = "/tmp/mcp-cron-spike.db";
const LOG_PATH = "/tmp/mcp-cron-spike.log";
const MARKER = `env-inherit-${Date.now()}`;
const REPO_CWD = process.cwd(); // run via `npm run` → the mycelium root

/** Env handed to the mcp-cron DAEMON. We strip credential-shaped vars so test F genuinely
 *  runs with NO API key (a leaked key would let add_ai_task call out and invalidate the test),
 *  and inject SPIKE_MARKER so test B can prove the task inherits the daemon's env. */
function daemonEnv(): Record<string, string> {
  const KEY_RE = /(API_KEY|OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|CLAUDE|MISTRAL|COHERE|TOGETHER|GROQ)/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (KEY_RE.test(k)) continue;
    env[k] = v;
  }
  env["SPIKE_MARKER"] = MARKER;
  return env;
}

let callSeq = 0;
interface CallOut {
  raw: unknown;
  text: string;
  json: any;
  isError: boolean;
}
/** Invoke an mcp-cron tool through the AI-SDK toolset (same execute(args, opts) path Leash uses). */
async function call(tools: ToolSet, name: string, args: Record<string, unknown> = {}): Promise<CallOut> {
  const tool = tools[name] as { execute?: (a: unknown, o: unknown) => Promise<unknown> } | undefined;
  if (!tool?.execute) throw new Error(`tool not callable: ${name}`);
  const raw = await tool.execute(args, { toolCallId: `spike-${++callSeq}`, messages: [] });
  const r = raw as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
  const text = Array.isArray(r?.content)
    ? r.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n")
    : typeof raw === "string"
      ? raw
      : JSON.stringify(raw);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — leave undefined */
  }
  return { raw, text, json, isError: !!r?.isError };
}

const results: { id: string; pass: boolean; detail: string }[] = [];
function record(id: string, pass: boolean, detail: string): void {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${detail}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find a task id out of whatever shape add_task / get_task return. */
function taskId(c: CallOut): string | undefined {
  const j = c.json;
  if (!j) {
    const m = c.text.match(/task_[0-9a-f]+/i);
    return m?.[0];
  }
  return j.id ?? j.task?.id ?? j.taskId;
}

/** add_task creates tasks DISABLED by default — a task must be enabled before run_task / cron fires it. */
async function addEnabled(tools: ToolSet, addTool: string, args: Record<string, unknown>): Promise<string | undefined> {
  const added = await call(tools, addTool, args);
  const id = taskId(added);
  if (id) await call(tools, "enable_task", { id });
  return id;
}

async function main(): Promise<void> {
  console.log(`spike 09-mcp-cron: launching daemon (db=${DB_PATH}, marker=${MARKER}, cwd=${REPO_CWD})\n`);

  // ── tiny local echo server for test E (records the headers/body mcp-cron sends) ──
  let lastHttp: { headers: IncomingMessage["headers"]; body: string } | null = null;
  const echo = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastHttp = { headers: req.headers, body };
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("echo-ok");
    });
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as { port: number }).port;

  let client: MCPClient | undefined;
  try {
    client = await createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: "npx",
        args: ["-y", "mcp-cron", "--transport", "stdio", "--db-path", DB_PATH, "--log-file", LOG_PATH],
        cwd: REPO_CWD,
        env: daemonEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    const tools = (await client.tools()) as ToolSet;
    const names = Object.keys(tools).sort();
    console.log(`connected — ${names.length} tools: ${names.join(", ")}\n`);

    // ── A. Tool inventory ─────────────────────────────────────────────────────────
    const REQUIRED = [
      "list_tasks", "add_task", "add_http_task", "run_task", "enable_task",
      "disable_task", "remove_task", "get_task", "update_task", "get_task_result", "query_task_result",
    ];
    const missing = REQUIRED.filter((n) => !names.includes(n));
    record("A.inventory", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `all ${REQUIRED.length} present`);

    // ── B. Shell task inherits daemon env + cwd (MAKE-OR-BREAK) ──────────────────────
    let createdIds: string[] = [];
    try {
      const cmd = `node -e 'process.stdout.write(JSON.stringify({marker: process.env.SPIKE_MARKER || null, cwd: process.cwd()}))'`;
      const id = await addEnabled(tools, "add_task", { name: "spike-env", command: cmd });
      if (id) createdIds.push(id);
      const run = await call(tools, "run_task", { id });
      // result text may wrap the row; pull the JSON the command printed
      const out = run.text;
      const m = out.match(/\{[^]*"marker"[^]*\}/);
      const parsed = m ? JSON.parse(m[0]) : run.json?.output ? JSON.parse(String(run.json.output).match(/\{[^]*\}/)?.[0] ?? "{}") : null;
      const gotMarker = parsed?.marker === MARKER;
      const gotCwd = parsed?.cwd === REPO_CWD;
      record("B.env", gotMarker, gotMarker ? `task saw SPIKE_MARKER=${MARKER}` : `marker NOT inherited (got ${JSON.stringify(parsed?.marker)}) — raw: ${out.slice(0, 240)}`);
      record("B.cwd", gotCwd, gotCwd ? `task cwd == daemon cwd (${REPO_CWD})` : `task cwd=${JSON.stringify(parsed?.cwd)} (daemon cwd=${REPO_CWD})`);
    } catch (e) {
      record("B.env", false, `threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── C. Cron scheduling actually fires ───────────────────────────────────────────
    try {
      const id = await addEnabled(tools, "add_task", { name: "spike-cron", schedule: "*/15 * * * * *", command: "echo spike-cron-fired" });
      if (id) createdIds.push(id);
      let runs = 0;
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        await sleep(5_000);
        // get_task_result throws "resource not found" until the first run lands — treat as 0.
        let res: CallOut | null = null;
        try {
          res = await call(tools, "get_task_result", { id, limit: 10 });
        } catch {
          continue;
        }
        const txt = res.text;
        runs = (txt.match(/spike-cron-fired/g) ?? []).length || (Array.isArray(res.json) ? res.json.length : res.json?.results?.length ?? 0);
        if (runs >= 1) break;
      }
      record("C.cron", runs >= 1, runs >= 1 ? `fired ${runs}× on */15s schedule` : `no run recorded within 75s`);
    } catch (e) {
      record("C.cron", false, `threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── D. SQLite path honored ───────────────────────────────────────────────────────
    const dbHere = existsSync(DB_PATH);
    const homeDefault = existsSync(`${process.env["HOME"]}/.mcp-cron`);
    record("D.sqlite", dbHere, dbHere ? `db at --db-path ${DB_PATH}${homeDefault ? " (note: ~/.mcp-cron ALSO exists)" : ""}` : `db NOT at ${DB_PATH}`);

    // ── E. HTTP task custom headers (informational) ──────────────────────────────────
    try {
      const id = await addEnabled(tools, "add_http_task", {
        name: "spike-http",
        url: `http://127.0.0.1:${echoPort}/echo`,
        method: "POST",
        headers: { "X-Spike-Header": "spike-hdr-OK" },
        body: "ping",
      });
      if (id) createdIds.push(id);
      await call(tools, "run_task", { id });
      await sleep(500);
      const sawHeader = lastHttp?.headers["x-spike-header"] === "spike-hdr-OK";
      record("E.http-headers", sawHeader, sawHeader ? "custom header delivered" : `header not seen (got: ${JSON.stringify(lastHttp?.headers?.["x-spike-header"])}) [informational]`);
    } catch (e) {
      record("E.http-headers", false, `threw (informational): ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── F. add_ai_task guard — must ERROR with no API key, never silently call out ───
    try {
      const hasAi = names.includes("add_ai_task");
      const id = await addEnabled(tools, "add_ai_task", { name: "spike-ai", prompt: "say hi" });
      if (id) createdIds.push(id);
      const run = await call(tools, "run_task", { id });
      const errored = run.isError || /error|fail|api[_ ]?key|unauthor|missing|no .*key/i.test(run.text);
      record("F.ai-guard", hasAi && errored, hasAi ? (errored ? `errors with no key — "${run.text.slice(0, 200).replace(/\s+/g, " ")}"` : `DID NOT ERROR (DANGER): ${run.text.slice(0, 200)}`) : "add_ai_task absent");
    } catch (e) {
      // a throw is also acceptable — it did NOT silently call out
      record("F.ai-guard", true, `errored (threw, no silent call-out): ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── cleanup created tasks ────────────────────────────────────────────────────────
    for (const id of createdIds) {
      try {
        await call(tools, "remove_task", { id });
      } catch {
        /* best-effort */
      }
    }
  } finally {
    if (client) await client.close().catch(() => {});
    echo.close();
  }

  // ── summary ──────────────────────────────────────────────────────────────────────
  const gate = ["A.inventory", "B.env", "C.cron", "D.sqlite", "F.ai-guard"];
  const gateResults = gate.map((id) => results.find((r) => r.id === id));
  const go = gateResults.every((r) => r?.pass);
  console.log("\n──────── SUMMARY ────────");
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.id}: ${r.detail}`);
  console.log(`\n  GATE (A,B,C,D,F): ${go ? "GO ✅" : "NO-GO ❌"}`);
  console.log("  (E is informational — heartbeat uses a shell task, not an HTTP task.)");
  if (!go) process.exitCode = 1;
}

main().catch((e) => {
  console.error("spike 09-mcp-cron crashed:", e);
  process.exitCode = 1;
});
