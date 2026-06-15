/**
 * cron-client (server-only) — a typed wrapper over the mcp-cron scheduling daemon.
 *
 * mcp-cron runs as a detached Streamable-HTTP MCP daemon (see the `mcp-cron` ServiceDef
 * in services.ts), bound to localhost. This module owns ONE @ai-sdk/mcp HTTP connection
 * to it (cached on globalThis so Next dev-reloads reuse it), lazily starting the daemon
 * the first time it's needed, and exposes the small surface `schedules-store.ts` needs.
 *
 * Two mcp-cron behaviors proven in spike/09-mcp-cron.ts are handled here so callers don't
 * have to: (1) `add_task` creates tasks DISABLED — we apply the desired enabled state via
 * enable_task/disable_task after adding; (2) `get_task_result` THROWS "resource not found"
 * when a task has no result rows yet — `cronResults` treats that as an empty history.
 *
 * NEVER calls `add_ai_task` — all inference stays in Leash on @qvac/sdk (hard rule #1).
 */
import "server-only";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

const PORT = Number(process.env["LEASH_CRON_MCP_PORT"] ?? 11448);
const ENDPOINT = `http://127.0.0.1:${PORT}/`;

/** Next patches global fetch and tries to cache bodies; MCP HTTP responses must not be cached. */
const cronFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CronConn {
  client: MCPClient;
  tools: ToolSet;
}
const g = globalThis as unknown as { __leashCron?: { conn: CronConn | null; connecting: Promise<CronConn> | null } };
const reg = (g.__leashCron ??= { conn: null, connecting: null });

/** Any HTTP answer on the MCP endpoint means the listener is up (mcp-cron has no /health). */
async function portUp(): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT, { method: "GET", signal: AbortSignal.timeout(1500) });
    return r.status > 0;
  } catch {
    return false;
  }
}

/** Start the daemon if it isn't listening, and wait for the port (first `npx -y mcp-cron` may download). */
async function ensureDaemon(): Promise<void> {
  if (await portUp()) return;
  // Lazy import: keeps the heavy server-supervision chain (prisma, serve-control) off this
  // module's import graph, so the hot read path only pays for it when the daemon is actually down.
  const { startService } = await import("./services.ts");
  await startService("mcp-cron").catch(() => {
    /* already running / overlay still downloading — the port wait below covers it */
  });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (await portUp()) return;
  }
  throw new Error(`mcp-cron did not come up on :${PORT}`);
}

async function connect(): Promise<CronConn> {
  if (reg.conn) return reg.conn;
  if (reg.connecting) return reg.connecting;
  reg.connecting = (async () => {
    await ensureDaemon();
    const client = await withTimeout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createMCPClient({ transport: { type: "http", url: ENDPOINT, fetch: cronFetch } as any }),
      15_000,
      "connect mcp-cron",
    );
    const tools = (await withTimeout(client.tools(), 15_000, "discover mcp-cron tools")) as ToolSet;
    const conn: CronConn = { client, tools };
    reg.conn = conn;
    return conn;
  })();
  try {
    return await reg.connecting;
  } catch (e) {
    reg.conn = null;
    throw e;
  } finally {
    reg.connecting = null;
  }
}

/** Drop the cached connection (used after a transport-level error so the next call reconnects). */
async function resetConn(): Promise<void> {
  const c = reg.conn;
  reg.conn = null;
  if (c) await c.client.close().catch(() => {});
}

const CONNECTION_ERR = /fetch failed|ECONNREFUSED|ECONNRESET|socket|closed|terminated|network|timed out|aborted/i;
let seq = 0;

interface CallOut {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  isError: boolean;
}

/**
 * Invoke an mcp-cron tool. Tool-level errors (e.g. "resource not found", "cannot run
 * disabled task") come back as THROWN JSON-RPC errors — we surface those as
 * `{ isError: true }` rather than throwing, so callers branch on a value. Transport-level
 * errors get ONE reconnect+retry (the daemon may have restarted); a second failure throws.
 */
async function call(name: string, args: Record<string, unknown> = {}, _retried = false): Promise<CallOut> {
  const conn = await connect();
  const tool = conn.tools[name] as { execute?: (a: unknown, o: unknown) => Promise<unknown> } | undefined;
  if (!tool?.execute) throw new Error(`mcp-cron tool not callable: ${name}`);
  let raw: unknown;
  try {
    raw = await tool.execute(args, { toolCallId: `cron-${++seq}`, messages: [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!_retried && CONNECTION_ERR.test(msg)) {
      await resetConn();
      return call(name, args, true);
    }
    return { text: msg, json: undefined, isError: true };
  }
  const r = raw as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = Array.isArray(r?.content)
    ? r.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n")
    : typeof raw === "string"
      ? raw
      : JSON.stringify(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* a plain-message success response (e.g. remove_task) — leave json undefined */
  }
  return { text, json, isError: !!r?.isError };
}

// ── typed surface ────────────────────────────────────────────────────────────────

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  /** Free-form metadata channel — schedules-store stores its Leash ScheduleEntry JSON here. */
  description?: string;
  /** epoch ms (absent when never run / not yet scheduled). */
  lastRun?: number;
  nextRun?: number;
  lastStatus?: "ok" | "error";
}

/** mcp-cron Task JSON → CronTask. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTask(t: any): CronTask {
  const ms = (v: unknown): number | undefined => {
    if (typeof v !== "string" || !v) return undefined;
    const n = Date.parse(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    id: String(t?.id ?? ""),
    name: String(t?.name ?? ""),
    schedule: String(t?.schedule ?? ""),
    command: String(t?.command ?? ""),
    enabled: !!t?.enabled,
    ...(typeof t?.description === "string" && t.description ? { description: t.description } : {}),
    lastRun: ms(t?.lastRun),
    nextRun: ms(t?.nextRun),
    lastStatus: t?.status === "completed" ? "ok" : t?.status === "failed" ? "error" : undefined,
  };
}

export async function cronList(): Promise<CronTask[]> {
  const r = await call("list_tasks", {});
  return Array.isArray(r.json) ? r.json.map(mapTask) : [];
}

export async function cronGet(id: string): Promise<CronTask | null> {
  const r = await call("get_task", { id });
  return !r.isError && r.json ? mapTask(r.json) : null;
}

export async function cronAdd(input: { name: string; schedule: string; command: string; enabled: boolean; description?: string }): Promise<CronTask | null> {
  const added = await call("add_task", {
    name: input.name,
    schedule: input.schedule,
    command: input.command,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  const id = added.json?.id as string | undefined;
  if (added.isError || !id) return null;
  // add_task creates the task DISABLED — apply the desired state, then re-read for nextRun.
  await call(input.enabled ? "enable_task" : "disable_task", { id });
  return (await cronGet(id)) ?? mapTask({ ...added.json, enabled: input.enabled });
}

export async function cronUpdate(id: string, patch: Partial<Pick<CronTask, "name" | "schedule" | "command" | "enabled" | "description">>): Promise<CronTask | null> {
  const fields: Record<string, unknown> = {};
  if (patch.name !== undefined) fields["name"] = patch.name;
  if (patch.schedule !== undefined) fields["schedule"] = patch.schedule;
  if (patch.command !== undefined) fields["command"] = patch.command;
  if (patch.description !== undefined) fields["description"] = patch.description;
  if (Object.keys(fields).length > 0) {
    const r = await call("update_task", { id, ...fields });
    if (r.isError) return null;
  }
  if (patch.enabled !== undefined) await call(patch.enabled ? "enable_task" : "disable_task", { id });
  return cronGet(id);
}

export async function cronRemove(id: string): Promise<boolean> {
  const r = await call("remove_task", { id });
  return !r.isError;
}

export interface CronResult {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  exitCode?: number;
  output: string;
  error?: string;
}

/** Recent run rows for a task, newest first. Empty when the task has never run (mcp-cron throws there). */
export async function cronResults(id: string, limit = 30): Promise<CronResult[]> {
  let r: CallOut;
  try {
    r = await call("get_task_result", { id, limit });
  } catch {
    return [];
  }
  if (r.isError) return []; // "resource not found" — no rows yet
  const rows = Array.isArray(r.json) ? r.json : r.json ? [r.json] : [];
  const ms = (v: unknown): number => Date.parse(typeof v === "string" ? v : "") || 0;
  return rows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((x: any) => {
      const started = ms(x?.start_time);
      const finished = ms(x?.end_time) || started;
      return {
        startedAt: started || finished,
        finishedAt: finished,
        ok: x?.exit_code === 0,
        ...(typeof x?.exit_code === "number" ? { exitCode: x.exit_code as number } : {}),
        output: String(x?.output ?? ""),
        ...(x?.error ? { error: String(x.error) } : {}),
      } satisfies CronResult;
    })
    .sort((a, b) => b.finishedAt - a.finishedAt);
}
