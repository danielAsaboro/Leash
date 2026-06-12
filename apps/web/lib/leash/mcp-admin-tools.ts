/**
 * MCP admin tools (server-only) — the structured registry tools for the MCP lane.
 *
 *   install_mcp_repo — COMPOUND tool: clone→install→build→detect→register→connect a server from
 *                      a github/listing URL in ONE call. The model fumbles that chain step-by-step
 *                      (SmallCode's finding: small models lose coherence past 3 sequential calls),
 *                      so the multi-step work lives in reliable code (mcp-install.ts) and the model
 *                      just triggers it. This is the happy path.
 *   upsert_mcp_server — manual escape hatch: validate→save→connect→verify ONE entry by hand (for
 *                      http/sse servers, or to fix a saved stdio entry). Never edits leash-mcp.json directly.
 *
 * Both are SKILL-GATED via the `mcp-installer` skill, so the lane costs 0 schema slots until it activates.
 */
import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { basename } from "node:path";
import { addMcpServer, listMcpServers, updateMcpServer, type McpServerEntry } from "./mcp-store.ts";
import { mcpServerStatuses, retryMcpServer, type McpServerStatus } from "./mcp.ts";
import { serverSignature, validateServerInput, type McpServerInput, type McpTransport } from "./mcp-config.ts";
import { installMcpRepo } from "./mcp-install.ts";

/** SKILL-GATED: kept out of every route's always-on toolset; activated only by `mcp-installer`. */
export const MCP_ADMIN_TOOL_NAMES = new Set(["install_mcp_repo", "upsert_mcp_server"]);

function fmtStatus(s: McpServerStatus): string {
  const bits = [
    `${s.name} (${s.transport})`,
    s.connected ? "connected" : s.enabled ? "not connected" : "off",
    s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") : (s.url ?? ""),
    s.transport === "stdio" && s.cwd ? `cwd ${s.cwd}` : "",
    s.toolNames.length ? `tools: ${s.toolNames.join(", ")}` : "",
    s.error ? `error: ${s.error}` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function editableServer(entry: McpServerEntry | undefined): entry is McpServerEntry & { builtin?: false; fromEnv?: false } {
  return !!entry && !entry.builtin && !entry.fromEnv;
}

async function findExisting(input: McpServerInput & { id?: string }): Promise<McpServerEntry | undefined> {
  const servers = await listMcpServers();
  if (input.id) return servers.find((s) => s.id === input.id);

  const normalized = validateServerInput(input);
  const sig = serverSignature(normalized);
  const exact = servers.find((s) => editableServer(s) && serverSignature(s) === sig);
  if (exact) return exact;

  if (normalized.name) {
    const byName = servers.find((s) => editableServer(s) && s.name.trim().toLowerCase() === normalized.name.trim().toLowerCase());
    if (byName) return byName;
  }
  return undefined;
}

async function statusFor(id: string): Promise<McpServerStatus | undefined> {
  const statuses = await mcpServerStatuses();
  return statuses.find((s) => s.id === id);
}

export const mcpAdminTools = {
  install_mcp_repo: tool({
    description:
      "Install an MCP server from a github.com repo URL or an mcpservers.org listing URL — clones, installs deps, builds, registers, and connects it, ALL in one call. Use this for any 'install / set up / add this MCP' request: just pass the URL. Pauses for the user's approval (it runs the repo's own install).",
    inputSchema: z.object({
      url: z.string().describe("A github.com/OWNER/NAME URL, or an mcpservers.org listing URL."),
      name: z.string().optional().describe("Optional display name for the server (defaults to the repo name)."),
    }),
    execute: async ({ url, name }) => {
      const r = await installMcpRepo(url);
      const stepLog = r.steps.length ? `\n\nSteps:\n- ${r.steps.join("\n- ")}` : "";
      if (!r.ok || !r.command) {
        return {
          text:
            `Couldn't install the MCP server.\nError: ${r.error ?? "unknown"}` +
            (r.repoDir ? `\nDownloaded copy: ${r.repoDir} (kept so you can inspect or fix it).` : "\nNothing was downloaded.") +
            stepLog,
        };
      }
      // Register + connect + verify. Idempotent: reuse an existing editable entry with the same
      // signature/name (a re-install repoints it) instead of piling up duplicates. The npx path has
      // no repoDir/cwd (`npx -y <pkg>` runs from anywhere); the clone path sets cwd to the repo.
      const display = name?.trim() || basename(r.repoDir ?? r.args?.[r.args.length - 1] ?? "mcp-server");
      const payload: McpServerInput = { name: display, transport: "stdio", command: r.command, args: r.args ?? [], ...(r.repoDir ? { cwd: r.repoDir } : {}) };
      const existing = await findExisting(payload);
      const saved = existing && editableServer(existing) ? await updateMcpServer(existing.id, { ...payload, enabled: true }) : await addMcpServer(payload);
      if (!saved) return { text: `Built ${r.repoDir} but couldn't save the registry entry.${stepLog}` };
      await retryMcpServer(saved.id);
      const status = await statusFor(saved.id);
      if (status?.connected) {
        return { text: `Installed and connected "${status.name}". Tools: ${status.toolNames.join(", ") || "(it exposes no tools)"}.`, server: saved, status };
      }
      return {
        text:
          `Installed "${saved.name}" but it didn't connect: ${status?.error ?? "unknown error"}.\n` +
          `It's saved (cwd ${r.repoDir}, \`${r.command} ${(r.args ?? []).join(" ")}\`) — it may need an env var, or the start command is off.` +
          stepLog,
        server: saved,
        status,
      };
    },
  }),

  upsert_mcp_server: tool({
    description:
      "Create or update one MCP server entry and immediately retry its connection. Use this after you've inspected/built a repo with shell tools. Prefer this over editing data/leash-mcp.json by hand.",
    inputSchema: z.object({
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
    }),
    execute: async (input) => {
      const existing = await findExisting(input);
      if (existing && !editableServer(existing)) {
        return {
          text: existing.builtin
            ? `Can't update "${existing.name}" here because it is a built-in MCP integration.`
            : `Can't update "${existing.name}" here because it comes from LEASH_MCP_SERVERS.`,
        };
      }

      const payload: McpServerInput = {
        ...(input.name ? { name: input.name } : {}),
        transport: input.transport as McpTransport,
        ...(input.url ? { url: input.url } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.args ? { args: input.args } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      };

      let saved: McpServerEntry | null;
      if (existing) {
        saved = await updateMcpServer(existing.id, { ...payload, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) });
      } else {
        saved = await addMcpServer(payload);
        if (input.enabled === false) {
          saved = await updateMcpServer(saved.id, { enabled: false });
        }
      }
      if (!saved) return { text: "Failed to save the MCP server entry." };

      await retryMcpServer(saved.id);
      const status = await statusFor(saved.id);
      if (!status) return { text: `Saved "${saved.name}", but couldn't load its live status yet.`, server: saved };

      return {
        text: `${existing ? "Updated" : "Saved"} MCP server: ${fmtStatus(status)}`,
        server: saved,
        status,
      };
    },
  }),
};
