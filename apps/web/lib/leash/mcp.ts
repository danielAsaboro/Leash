/**
 * MCP tool layer (server-only) — store-driven (Brain → MCP) + `LEASH_MCP_SERVERS` env.
 *
 * Clients are cached per server URL and reconciled against the CURRENT store snapshot
 * on every read: new enabled servers connect, removed/disabled ones are closed (their
 * pending elicitations cancelled). Each client advertises the `elicitation` capability
 * and bridges `elicitation/create` requests into the in-memory broker
 * (`elicitations.ts`) — the chat stream renders them as in-chat forms.
 *
 * With nothing configured this returns `{}` — an honest empty state, not a mock.
 */
import "server-only";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ToolSet } from "ai";
import { createMCPClient, ElicitationRequestSchema, type ElicitResult, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { listMcpServers, type McpServerEntry } from "./mcp-store.ts";
import { MCP_REPOS_DIR } from "./mcp-install.ts";
import { requestElicitation, cancelElicitationsFor } from "./elicitations.ts";
import { parseIcons, resolveBestIcon, resolveUserIcon } from "./mcp-icons.ts";

interface Connection {
  entry: McpServerEntry;
  client: MCPClient;
  tools: ToolSet;
  toolNames: string[];
  connectedAt: number;
  /** Server's own advertised icon, resolved to a cached data URI (offline-safe). */
  iconDataUri?: string;
  /** Per-tool advertised icons (tool name → cached data URI). */
  toolIcons?: Record<string, string>;
}

interface FailedAttempt {
  at: number;
  error: string;
}

interface Registry {
  connections: Map<string, Connection>; // keyed by entry id
  failures: Map<string, FailedAttempt>; // keyed by entry id (last failed connect, for status)
  reconciling: Promise<void> | null;
}

// On globalThis so Next dev-mode reloads reuse live connections instead of leaking them.
const g = globalThis as unknown as { __leashMcp?: Registry };
const registry: Registry = (g.__leashMcp ??= { connections: new Map(), failures: new Map(), reconciling: null });

/** How long a failed connect is remembered before we retry (avoids hammering a dead server every turn). */
const FAILURE_TTL_MS = 30_000;
/** Bound the initial MCP connect/tool-discovery handshake so one dead server can't wedge chat. */
const CONNECT_TIMEOUT_MS = Number(process.env["LEASH_MCP_CONNECT_TIMEOUT_MS"] ?? 5_000);
/** Longer budget for `npx`/`npm`/… launchers: their FIRST run downloads the package before the server even starts. */
const PM_CONNECT_TIMEOUT_MS = Number(process.env["LEASH_MCP_PM_CONNECT_TIMEOUT_MS"] ?? 90_000);
/** Bound the (cosmetic) icon harvest — per-fetch timeouts already apply; this caps the whole pass. */
const ICON_HARVEST_TIMEOUT_MS = 8_000;

// Next.js patches globalThis.fetch and tries to cache every response body. MCP transports
// use SSE streams that never close, so the body-read times out with "Failed to set fetch
// cache". Passing `cache: 'no-store'` tells Next.js not to buffer the response.
const mcpFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

/** Package-manager launchers that fetch into a cache — `npx -y <pkg>` MCP servers, etc. */
const PM_COMMAND_RE = /^(npx|npm|yarn|pnpm|pnpx|bunx|bun)$/;

/**
 * Env for a spawned stdio server. For a package-manager launcher (`npx`/`npm`/…) we inject a
 * minimal inherited env (PATH/HOME/LANG — enough to find + run node) and redirect its cache + temp
 * onto the repos' volume, so an `npx -y <pkg>` fetch doesn't ENOSPC on a full system disk. Other
 * commands keep their entry env (or the SDK's safe default). We never pass the full process env —
 * spawned third-party servers shouldn't see Leash's secrets.
 */
function stdioEnv(entry: McpServerEntry): Record<string, string> | undefined {
  const isPm = PM_COMMAND_RE.test((entry.command ?? "").trim());
  if (!isPm) return entry.env;
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG"]) if (process.env[k]) env[k] = process.env[k] as string;
  const cache = join(MCP_REPOS_DIR, ".cache");
  for (const sub of ["npm", "yarn", "tmp"]) {
    try {
      mkdirSync(join(cache, sub), { recursive: true });
    } catch {
      /* best-effort */
    }
  }
  env["npm_config_cache"] = join(cache, "npm");
  env["YARN_CACHE_FOLDER"] = join(cache, "yarn");
  env["TMPDIR"] = join(cache, "tmp");
  return { ...env, ...(entry.env ?? {}) };
}

/** Build the @ai-sdk/mcp transport for an entry — a spawned stdio process, or an http/sse URL with optional auth headers. */
function transportFor(entry: McpServerEntry): unknown {
  if (entry.transport === "stdio") {
    const env = stdioEnv(entry);
    return new Experimental_StdioMCPTransport({
      command: entry.command as string,
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(env ? { env } : {}),
    });
  }
  return { type: entry.transport, url: entry.url, fetch: mcpFetch, ...(entry.headers ? { headers: entry.headers } : {}) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connectOne(entry: McpServerEntry): Promise<void> {
  let client: MCPClient | undefined;
  // A package-manager launcher (`npx -y <pkg>`) DOWNLOADS the package on its first run, which
  // easily exceeds the snappy default — give those a much longer connect budget (subsequent
  // runs hit the cache and are fast). Everything else stays on the short timeout.
  const connectTimeout = PM_COMMAND_RE.test((entry.command ?? "").trim()) ? PM_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
  try {
    client = await withTimeout(
      createMCPClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport: transportFor(entry) as any,
      // Advertise elicitation support; server→client elicitInput lands in the broker and
      // times out to cancel there, so a tool call can pause on a human form mid-chat.
      capabilities: { elicitation: {} },
      }),
      connectTimeout,
      `connect ${entry.name}`,
    );
    client.onElicitationRequest(
      ElicitationRequestSchema,
      (request) =>
        requestElicitation({
          serverName: entry.name,
          message: request.params.message,
          requestedSchema: request.params.requestedSchema,
        }) as Promise<ElicitResult>, // ElicitResultLike is the index-signature-free subset
    );
    const tools = await withTimeout(client.tools(), connectTimeout, `discover tools from ${entry.name}`);
    // Best-effort: harvest the icons the server advertises on serverInfo + each tool. Cosmetic —
    // a slow or dead icon host must NEVER fail or stall the connection beyond this bound.
    let iconDataUri: string | undefined;
    let toolIcons: Record<string, string> | undefined;
    try {
      const harvested = await withTimeout(harvestIcons(client), ICON_HARVEST_TIMEOUT_MS, `icons from ${entry.name}`);
      iconDataUri = harvested.serverIcon;
      if (Object.keys(harvested.toolIcons).length) toolIcons = harvested.toolIcons;
    } catch (e) {
      console.warn(`leash mcp: icon harvest skipped for ${entry.name}:`, e instanceof Error ? e.message : e);
    }
    registry.connections.set(entry.id, { entry, client, tools, toolNames: Object.keys(tools), connectedAt: Date.now(), iconDataUri, toolIcons });
    registry.failures.delete(entry.id);
    console.log(`leash mcp: connected ${entry.name} (${connectTarget(entry)}) — ${Object.keys(tools).length} tool(s)`);
  } catch (err) {
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore close failure on half-open clients */
      }
    }
    registry.failures.set(entry.id, { at: Date.now(), error: err instanceof Error ? err.message : String(err) });
    console.error(`leash mcp: failed to connect ${entry.name} (${connectTarget(entry)}):`, err);
  }
}

/**
 * Read the OPTIONAL `icons` off `serverInfo` + each tool — both survive `@ai-sdk/mcp`'s
 * `.loose()` parse as untyped extras, validated/resolved in `mcp-icons.ts`. Tool icons resolve
 * in parallel so the pass is bounded by the slowest single fetch, not their sum.
 */
async function harvestIcons(client: MCPClient): Promise<{ serverIcon?: string; toolIcons: Record<string, string> }> {
  const serverIcon = await resolveBestIcon(parseIcons((client.serverInfo as Record<string, unknown>)["icons"]));
  const list = await client.listTools();
  const resolved = await Promise.all(
    list.tools.map(async (t) => {
      const uri = await resolveBestIcon(parseIcons((t as Record<string, unknown>)["icons"]));
      return uri ? ([t.name, uri] as const) : null;
    }),
  );
  return { serverIcon, toolIcons: Object.fromEntries(resolved.filter((e): e is readonly [string, string] => e !== null)) };
}

/** Human-readable connection target for logs (URL for http/sse, command for stdio). */
function connectTarget(entry: McpServerEntry): string {
  if (entry.transport !== "stdio") return entry.url ?? "";
  const command = `${entry.command ?? ""} ${(entry.args ?? []).join(" ")}`.trim();
  return entry.cwd ? `${command} (cwd: ${entry.cwd})` : command;
}

async function closeOne(id: string): Promise<void> {
  const conn = registry.connections.get(id);
  if (!conn) return;
  registry.connections.delete(id);
  cancelElicitationsFor(conn.entry.name); // a form from a gone server can never be answered
  try {
    await conn.client.close();
  } catch {
    /* already dead */
  }
  console.log(`leash mcp: closed ${conn.entry.name} (${connectTarget(conn.entry)})`);
}

/** Reconcile live connections against the store snapshot (serialized — one at a time). */
async function reconcile(): Promise<void> {
  if (registry.reconciling) return registry.reconciling;
  const run = (async () => {
    const desired = (await listMcpServers()).filter((s) => s.enabled);
    const desiredById = new Map(desired.map((s) => [s.id, s]));
    // Close connections whose server is gone or disabled.
    for (const id of [...registry.connections.keys()]) {
      if (!desiredById.has(id)) await closeOne(id);
    }
    // Connect new ones (respecting the failure cool-down).
    for (const entry of desired) {
      if (registry.connections.has(entry.id)) continue;
      const failed = registry.failures.get(entry.id);
      if (failed && Date.now() - failed.at < FAILURE_TTL_MS) continue;
      await connectOne(entry);
    }
  })();
  registry.reconciling = run;
  try {
    await run;
  } finally {
    registry.reconciling = null;
  }
}

/** Tools from every connected MCP server (reconciled against the store on each call). */
export async function leashMcpTools(): Promise<ToolSet> {
  await reconcile();
  let merged: ToolSet = {};
  for (const conn of registry.connections.values()) merged = { ...merged, ...conn.tools };
  return merged;
}

/** Drop a server's remembered failure and reconcile now (used after fixing config). */
export async function retryMcpServer(id?: string): Promise<void> {
  if (id) registry.failures.delete(id);
  else registry.failures.clear();
  await reconcile();
}

/**
 * Per-server status for the dashboard. Secret-bearing fields (header values, stdio env
 * values) are NEVER sent to the client — only their KEYS, so the UI can show "1 header"
 * without leaking the token. Account data is public on-device, but API tokens are not.
 */
export interface McpServerStatus extends Omit<McpServerEntry, "headers" | "env" | "userIcon"> {
  connected: boolean;
  toolNames: string[];
  /** Last connect error while disconnected (honest failure surface). */
  error?: string;
  /** Auth header names (values redacted). */
  headerNames?: string[];
  /** stdio env var names (values redacted). */
  envNames?: string[];
  /** Effective icon as a cached data URI: user-chosen icon if set, else the server-advertised one; absent → placeholder. */
  iconDataUri?: string;
}

/** Per-server status for the dashboard (config + live connection + tool names). */
export async function mcpServerStatuses(): Promise<McpServerStatus[]> {
  await reconcile();
  const servers = await listMcpServers();
  return Promise.all(
    servers.map(async (s) => {
      const conn = registry.connections.get(s.id);
      const failed = registry.failures.get(s.id);
      const { headers, env, userIcon, ...safe } = s;
      // User-chosen icon wins (resolved to an offline-safe data URI); else the server-advertised one.
      const icon = (userIcon ? await resolveUserIcon(userIcon) : undefined) ?? conn?.iconDataUri;
      return {
        ...safe,
        connected: !!conn,
        toolNames: conn?.toolNames ?? [],
        ...(headers && Object.keys(headers).length ? { headerNames: Object.keys(headers) } : {}),
        ...(env && Object.keys(env).length ? { envNames: Object.keys(env) } : {}),
        ...(!conn && s.enabled && failed ? { error: failed.error } : {}),
        ...(icon ? { iconDataUri: icon } : {}),
      };
    }),
  );
}

/** MCP-advertised tool icons (tool name → data URI) across every connected server — for Brain → Tools. */
export async function mcpToolIcons(): Promise<Record<string, string>> {
  await reconcile();
  const out: Record<string, string> = {};
  for (const conn of registry.connections.values()) Object.assign(out, conn.toolIcons ?? {});
  return out;
}
