/**
 * MCP-admin tool group — the "MCP" server whose tools MANAGE other MCP servers.
 *
 *   install_mcp_repo — clone→install→build→detect a server from a github/listing URL, then
 *                      register it in the user's MCP config.
 *   upsert_mcp_server — validate + save one server entry by hand (http/sse/stdio).
 *
 * HONESTY across the process boundary: this daemon writes `data/leash-mcp.json`'s `servers[]`
 * (locked) but does NOT hold the live MCP client — the WEB process's `mcp.ts` reconcile owns
 * the connections. So these tools report "saved; it connects on the next chat turn" rather than
 * claiming a connection they can't observe. The web connects it for real and the Brain → MCP
 * panel shows the true status. (Both tools stay approval-gated by name in the web's tool-config.)
 */
import { z } from "zod";
import { basename } from "node:path";
import { installMcpRepo } from "../mcp-install.ts";
import { addOrUpdateServer } from "../mcp-admin-store.ts";
import type { McpServerInput, McpTransport } from "../mcp-config.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const NO_SOURCES: LeashSource[] = [];

export const mcpAdminGroup: ToolGroup = {
  id: "mcp-admin",
  label: "MCP",
  description: "Install and register other MCP servers from a URL or by hand (install_mcp_repo, upsert_mcp_server).",
  tools: [
    defineTool({
      name: "install_mcp_repo",
      needsApproval: true,
      description:
        "Install an MCP server from a github.com repo URL or an mcpservers.org listing URL — clones, installs deps, builds, and registers it. Use this for any 'install / set up / add this MCP' request: just pass the URL. Pauses for the user's approval (it runs the repo's own install).",
      inputSchema: {
        url: z.string().describe("A github.com/OWNER/NAME URL, or an mcpservers.org listing URL."),
        name: z.string().optional().describe("Optional display name for the server (defaults to the repo name)."),
      },
      handler: async ({ url, name }) => {
        const r = await installMcpRepo(url);
        const stepLog = r.steps.length ? `\n\nSteps:\n- ${r.steps.join("\n- ")}` : "";
        if (!r.ok || !r.command) {
          return {
            text:
              `Couldn't install the MCP server.\nError: ${r.error ?? "unknown"}` +
              (r.repoDir ? `\nDownloaded copy: ${r.repoDir} (kept so you can inspect or fix it).` : "\nNothing was downloaded.") +
              stepLog,
            sources: NO_SOURCES,
          };
        }
        const display = name?.trim() || basename(r.repoDir ?? r.args?.[r.args.length - 1] ?? "mcp-server");
        const payload: McpServerInput = { name: display, transport: "stdio", command: r.command, args: r.args ?? [], ...(r.repoDir ? { cwd: r.repoDir } : {}) };
        try {
          const { entry, updated } = await addOrUpdateServer({ ...payload, enabled: true });
          return {
            text:
              `${updated ? "Re-pointed" : "Installed and registered"} MCP server "${entry.name}" (\`${r.command} ${(r.args ?? []).join(" ")}\`${r.repoDir ? `, cwd ${r.repoDir}` : ""}). ` +
              `It will connect on the next chat turn — check Brain → MCP for its live status and tools.` +
              stepLog,
            sources: NO_SOURCES,
            server: entry,
          };
        } catch (err) {
          return { text: `Built ${r.repoDir ?? "the server"} but couldn't save the registry entry: ${err instanceof Error ? err.message : String(err)}${stepLog}`, sources: NO_SOURCES };
        }
      },
    }),

    defineTool({
      name: "upsert_mcp_server",
      needsApproval: true,
      description:
        "Create or update one MCP server entry. Use this after you've inspected/built a repo with shell tools, or to add an http/sse server by hand. Prefer this over editing data/leash-mcp.json directly.",
      inputSchema: {
        id: z.string().optional().describe("Existing server id to update, if known."),
        name: z.string().optional().describe("Display name."),
        transport: z.enum(["http", "sse", "stdio"]).describe("Connection type."),
        url: z.string().optional().describe("For http/sse servers."),
        command: z.string().optional().describe("For stdio servers."),
        args: z.array(z.string()).optional().describe("For stdio servers."),
        cwd: z.string().optional().describe("For stdio servers: working directory."),
        env: z.record(z.string(), z.string()).optional().describe("For stdio servers: environment variables."),
        headers: z.record(z.string(), z.string()).optional().describe("For http/sse servers: request headers."),
        enabled: z.boolean().optional().describe("Whether the server should be enabled after saving. Default true."),
      },
      handler: async (input) => {
        const payload: McpServerInput & { id?: string; enabled?: boolean } = {
          ...(input.id ? { id: input.id } : {}),
          ...(input.name ? { name: input.name } : {}),
          transport: input.transport as McpTransport,
          ...(input.url ? { url: input.url } : {}),
          ...(input.command ? { command: input.command } : {}),
          ...(input.args ? { args: input.args } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        };
        try {
          const { entry, updated } = await addOrUpdateServer(payload);
          const target = entry.transport === "stdio" ? `${entry.command} ${(entry.args ?? []).join(" ")}`.trim() : (entry.url ?? "");
          return {
            text: `${updated ? "Updated" : "Saved"} MCP server "${entry.name}" (${entry.transport}: ${target}). It connects on the next chat turn — check Brain → MCP for its live status.`,
            sources: NO_SOURCES,
            server: entry,
          };
        } catch (err) {
          return { text: `Couldn't save the MCP server entry: ${err instanceof Error ? err.message : String(err)}`, sources: NO_SOURCES };
        }
      },
    }),
  ],
};
