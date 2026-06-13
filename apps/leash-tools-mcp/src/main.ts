/**
 * Leash tools MCP daemon (:11440) — ONE process hosting EACH capability family as its own
 * MCP server on its own URL path:
 *
 *   GET /health            — liveness + the group catalog (the dashboard's readiness probe)
 *   *   /mcp/<group-id>     — that group's MCP Streamable HTTP endpoint (one McpServer per
 *                            session, the SDK's stateful pattern; routed by `mcp-session-id`)
 *
 * Each group is a built-in MCP server in the web's Brain → MCP panel that connects/disconnects
 * independently (so toggling "Home Assistant" off takes only its tools offline); the daemon
 * itself stays up while ANY group is enabled (reference-counted in the web's mcp-lifecycle).
 *
 * Every tool handler returns the canonical `{ text, sources, ...extra }`; we wrap it into an
 * MCP result — `content` text for the MODEL, `structuredContent` (sources + extras) for the
 * web UI's citation chips (mapped back in `apps/web/lib/leash/mcp.ts`). localhost-only.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TOOL_GROUPS, groupById, type ToolGroup, type GroupTool } from "@mycelium/leash-core/groups";
import { LEASH_TOOLS_MCP_PORT } from "./config.ts";

/** Sessions are per-GROUP (each group is a distinct MCP server / endpoint). */
const transportsByGroup = new Map<string, Map<string, StreamableHTTPServerTransport>>();
function transportsFor(id: string): Map<string, StreamableHTTPServerTransport> {
  let m = transportsByGroup.get(id);
  if (!m) {
    m = new Map();
    transportsByGroup.set(id, m);
  }
  return m;
}

/** Bridge a `{ text, sources, ...extra }` impl result into an MCP tool result. */
function registerGroupTool(server: McpServer, t: GroupTool): void {
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.inputSchema },
    async (args: Record<string, unknown>) => {
      const { text, ...structured } = await t.handler(args);
      // `structured` carries `sources` (+ any extras like `task`/`url`). The model reads the
      // text `content`; the web client lifts `structuredContent` back onto the tool output.
      return { content: [{ type: "text" as const, text }], structuredContent: structured };
    },
  );
}

function buildServer(group: ToolGroup): McpServer {
  const server = new McpServer({ name: `leash-${group.id}`, version: "0.1.0" });
  for (const t of group.tools) registerGroupTool(server, t);
  return server;
}

/** Total live sessions across all groups (for the health probe). */
function totalSessions(): number {
  let n = 0;
  for (const m of transportsByGroup.values()) n += m.size;
  return n;
}

const httpServer = http.createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";

    if (req.method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          port: LEASH_TOOLS_MCP_PORT,
          sessions: totalSessions(),
          groups: TOOL_GROUPS.map((g) => ({ id: g.id, label: g.label, tools: g.tools.map((t) => t.name) })),
        }),
      );
      return;
    }

    // /mcp/<group-id>[?…] — route to that group's MCP server.
    const m = url.match(/^\/mcp\/([^/?]+)/);
    if (m) {
      const groupId = m[1] as string;
      const group = groupById(groupId);
      if (!group) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown tool group "${groupId}"` }));
        return;
      }
      const transports = transportsFor(groupId);
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(sessionId ? 404 : 400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: sessionId ? "unknown or expired session" : "open a session with an initialize POST first" }));
          return;
        }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string): void => {
            transports.set(sid, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
        };
        await buildServer(group).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `leash-tools-mcp: no route ${req.method} ${url}` }));
  })().catch((err) => {
    console.error("leash-tools-mcp: request failed:", err);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      } else {
        res.end();
      }
    } catch {
      /* nothing more we can do */
    }
  });
});

httpServer.listen(LEASH_TOOLS_MCP_PORT, "127.0.0.1", () => {
  console.log(`🧰 leash-tools-mcp listening on http://127.0.0.1:${LEASH_TOOLS_MCP_PORT} — groups: ${TOOL_GROUPS.map((g) => g.id).join(", ")}`);
});
