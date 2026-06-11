/**
 * MCP server config — shared types + pure helpers (NO server-only, NO node builtins).
 *
 * This is the single validation/parse code path for MCP integrations, imported by:
 *   · the store (`mcp-store.ts`)        — server-side persistence + add/update
 *   · the API route                      — request validation
 *   · the "Create Custom Integration" modal (client) — live inline validation, the
 *     JSON-tab parsed preview, and "Format JSON" all run RIGHT HERE in the browser
 *   · the smoke (`scripts/smoke-mcp.ts`) — proves the rules without a server
 *
 * Keep it isomorphic: any `import "server-only"` or `node:*` here would break the
 * client bundle and the smoke. Persistence + connection live in their own modules.
 */

/** Streamable-HTTP / SSE remote servers, or a locally-spawned stdio server. */
export type McpTransport = "http" | "sse" | "stdio";

/** A configured MCP server as persisted in `data/leash-mcp.json`. */
export interface McpServerEntry {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** http/sse only. */
  url?: string;
  /** http/sse only — request headers (e.g. `Authorization`). May hold secrets. */
  headers?: Record<string, string>;
  /** stdio only — the executable to spawn. */
  command?: string;
  /** stdio only — argv after the command. */
  args?: string[];
  /** stdio only — extra env for the child. May hold secrets. */
  env?: Record<string, string>;
  /** True for `LEASH_MCP_SERVERS` env-seeded rows — read-only in the dashboard. */
  fromEnv?: boolean;
  /** True for code-defined built-ins (mesh tools) — non-deletable, lifecycle-bound. */
  builtin?: boolean;
}

/** The user-supplied shape for adding a server (id/enabled are assigned by the store). */
export interface McpServerInput {
  name?: string;
  transport?: McpTransport | string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A validated, normalized entry minus the fields the store assigns. */
export type NormalizedServer = Omit<McpServerEntry, "id" | "enabled" | "fromEnv" | "builtin">;

const URL_RE = /^https?:\/\/\S+$/;

function cleanRecord(rec: unknown): Record<string, string> | undefined {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    const key = k.trim();
    if (key && typeof v === "string" && v.length > 0) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanArgs(args: unknown): string[] | undefined {
  if (!Array.isArray(args)) return undefined;
  const out = args.filter((a): a is string => typeof a === "string");
  return out.length ? out : undefined;
}

/** A stable signature used to dedupe a server against the configured set. */
export function serverSignature(e: { transport: McpTransport; url?: string; command?: string; args?: string[] }): string {
  return e.transport === "stdio" ? `stdio:${e.command ?? ""} ${(e.args ?? []).join(" ")}`.trim() : `${e.transport}:${e.url ?? ""}`;
}

/** A friendly default name from the connection target. */
function defaultName(n: NormalizedServer): string {
  if (n.transport === "stdio") return (n.command ?? "stdio").split(/[\\/]/).pop() || "stdio";
  return (n.url ?? "").replace(/^https?:\/\//, "") || "mcp server";
}

/**
 * Validate + normalize one server input. Throws `Error` with a human message on any
 * problem (the message is surfaced verbatim in the UI). Pure — no I/O.
 */
export function validateServerInput(input: McpServerInput): NormalizedServer {
  const explicit = (input.transport ?? "").toString().trim().toLowerCase();
  // Infer when the type is omitted (common in pasted JSON): a `command` with no `url` is stdio, else http.
  const rawT = explicit || (input.command && !input.url ? "stdio" : "http");
  // Accept a couple of friendly aliases for the stdio/http types people paste in JSON.
  const transport: McpTransport =
    rawT === "stdio" || rawT === "command" ? "stdio" : rawT === "sse" ? "sse" : rawT === "http" || rawT === "streamable-http" ? "http" : (() => {
      throw new Error(`unknown server type "${rawT}" — use http, sse, or stdio`);
    })();

  if (transport === "stdio") {
    const command = (input.command ?? "").trim();
    if (!command) throw new Error("stdio servers need a command");
    const n: NormalizedServer = { transport, name: "", command };
    const args = cleanArgs(input.args);
    if (args) n.args = args;
    const env = cleanRecord(input.env);
    if (env) n.env = env;
    n.name = (input.name ?? "").trim() || defaultName(n);
    return n;
  }

  const url = (input.url ?? "").trim();
  if (!url) throw new Error(`${transport} servers need a URL`);
  if (!URL_RE.test(url)) throw new Error("URL must start with http:// or https://");
  const n: NormalizedServer = { transport, name: "", url };
  const headers = cleanRecord(input.headers);
  if (headers) n.headers = headers;
  n.name = (input.name ?? "").trim() || defaultName(n);
  return n;
}

export interface ParsedJsonImport {
  /** Successfully validated entries, in document order. */
  ready: { key: string; server: NormalizedServer }[];
  /** Per-entry validation failures (the key is the JSON object key). */
  errors: { key: string; error: string }[];
}

/**
 * Parse a pasted JSON config into validated servers. Lenient by design — accepts BOTH:
 *   { "mcpServers": { "name": { type|transport, url|command, headers|args|env } } }   (Claude-desktop wrapper)
 *   { "name": { ... } }                                                                 (bare map)
 * Per-entry failures are collected (not thrown) so a 3-server blob with one bad row
 * still imports the other two. Throws ONLY when the whole text isn't a JSON object.
 */
export function parseMcpJson(text: string): ParsedJsonImport {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("expected a JSON object of servers");

  const wrapped = (root as Record<string, unknown>)["mcpServers"];
  const map = wrapped && typeof wrapped === "object" && !Array.isArray(wrapped) ? (wrapped as Record<string, unknown>) : (root as Record<string, unknown>);

  const out: ParsedJsonImport = { ready: [], errors: [] };
  for (const [key, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      out.errors.push({ key, error: "each server must be an object" });
      continue;
    }
    const cfg = raw as Record<string, unknown>;
    try {
      const server = validateServerInput({
        name: typeof cfg["name"] === "string" ? (cfg["name"] as string) : key,
        transport: (cfg["type"] ?? cfg["transport"]) as string | undefined,
        url: cfg["url"] as string | undefined,
        headers: cfg["headers"] as Record<string, string> | undefined,
        command: cfg["command"] as string | undefined,
        args: cfg["args"] as string[] | undefined,
        env: cfg["env"] as Record<string, string> | undefined,
      });
      out.ready.push({ key, server });
    } catch (err) {
      out.errors.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Pretty-print a JSON string (2-space). Throws on unparseable input (drives the disabled "Format" state). */
export function formatMcpJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2);
}

/** The example shown in the JSON tab's "Expected Format" block — one http, one stdio. */
export const MCP_JSON_EXAMPLE = `{
  "tavily": {
    "type": "http",
    "url": "https://api.tavily.com/mcp",
    "headers": { "Authorization": "Bearer YOUR_API_TOKEN" }
  },
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"]
  }
}`;

/** Redact a secret-bearing value for display (keep a hint of length, never the value). */
export function maskValue(_v: string): string {
  return "••••••••";
}
