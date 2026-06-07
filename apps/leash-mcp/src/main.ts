/**
 * Leash MCP server (:11439) — mesh pairing as MCP tools, with PIN/device-choice
 * elicitation riding the Streamable HTTP session back into the Leash chat.
 *
 *   GET  /health  — liveness (the dashboard's Services probe)
 *   *    /mcp     — MCP Streamable HTTP endpoint (SESSION mode: server→client
 *                   `elicitInput` requests need the long-lived session stream)
 *
 * One McpServer per session (the SDK's stateful pattern): each POST /mcp initialize
 * creates a transport + server pair; later requests route by the `mcp-session-id`
 * header. localhost-only by design — bind 127.0.0.1.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerPairingTools } from "./pairing-tools.ts";
import { LEASH_MCP_PORT, HYPHA_URL } from "./config.ts";

const transports = new Map<string, StreamableHTTPServerTransport>();

function buildServer(): McpServer {
  const server = new McpServer({ name: "leash-mesh", version: "0.1.0" });
  registerPairingTools(server);
  return server;
}

const httpServer = http.createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, port: LEASH_MCP_PORT, sessions: transports.size, hypha: HYPHA_URL }));
      return;
    }

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        // Only a fresh POST (the initialize request) may open a session.
        if (req.method !== "POST") {
          res.writeHead(sessionId ? 404 : 400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: sessionId ? "unknown or expired session" : "open a session with an initialize POST first" }));
          return;
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => transports.set(sid, t),
        });
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
        };
        await buildServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `leash-mcp: no route ${req.method} ${url}` }));
  })().catch((err) => {
    // A route handler must never crash the daemon.
    console.error("leash-mcp: request failed:", err);
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

httpServer.listen(LEASH_MCP_PORT, "127.0.0.1", () => {
  console.log(`🧷 leash-mcp listening on http://127.0.0.1:${LEASH_MCP_PORT}/mcp (hypha at ${HYPHA_URL})`);
});
