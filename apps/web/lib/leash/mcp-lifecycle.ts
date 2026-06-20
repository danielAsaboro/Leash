/**
 * Built-in MCP lifecycle (server-only) — couples the "Mesh Tools" toggle in Brain → MCP
 * to the supervised `leash-mcp` daemon.
 *
 *   ON  → persist enabled, start the daemon, WAIT for its /health to answer (so the very
 *         next status read connects instead of caching a 30s connect-failure), then return.
 *   OFF → persist disabled (the next reconcile closes the connection), stop the daemon.
 *
 * Honest about partial failure: if the daemon won't come up, the toggle still flips on and
 * the result carries a `warning` the panel surfaces — never enabled-but-silently-dead.
 *
 * Separate from `mcp-builtins.ts` (pure registry data) and `mcp-store.ts` (persistence) to
 * avoid an import cycle — this is the one place that imports all three + the supervisor.
 */
import "server-only";
import { builtinById, MCP_BUILTINS } from "./mcp-builtins.ts";
import { setBuiltinEnabled, listMcpServers } from "./mcp-store.ts";
import { startService, forceStopService } from "./services.ts";
import type { McpServerEntry } from "./mcp-config.ts";

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 400;

async function waitHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* not up yet — keep polling until the deadline */
    }
    await new Promise((res) => setTimeout(res, READY_POLL_MS));
  }
  return false;
}

export interface BuiltinToggleResult {
  server: McpServerEntry;
  /** Non-fatal note surfaced in the UI (e.g. the daemon didn't come up in time). */
  warning?: string;
}

/** Turn a built-in on/off: persist the enabled bit, then drive its daemon. Throws on unknown id. */
export async function toggleBuiltin(id: string, enabled: boolean): Promise<BuiltinToggleResult> {
  const b = builtinById(id);
  if (!b) throw new Error(`unknown built-in "${id}"`);
  const server = await setBuiltinEnabled(id, enabled);

  if (!b.service) return { server };

  if (enabled) {
    const started = await startService(b.service); // ok:false "already running" is fine — health is the truth
    const ready = b.healthUrl ? await waitHealthy(b.healthUrl, READY_TIMEOUT_MS) : true;
    if (!ready) {
      const why = started.ok ? "the daemon started but isn't answering yet" : started.error ?? "the daemon failed to start";
      return { server, warning: `${b.name} is on, but ${why} — it'll connect once the daemon is healthy.` };
    }
    return { server };
  }

  // Reference-counted stop: a daemon may back SEVERAL built-ins (the leash-tools-mcp daemon
  // hosts one MCP server per tool group). Only stop it once the LAST built-in sharing this
  // `service` is off — otherwise just persist disabled and let the next reconcile close this
  // group's connection (its tools go offline; sibling groups keep working).
  const siblings = MCP_BUILTINS.filter((x) => x.service === b.service && x.id !== b.id);
  if (siblings.length > 0) {
    const servers = await listMcpServers();
    const anySiblingOn = siblings.some((s) => servers.find((e) => e.id === s.id)?.enabled);
    if (anySiblingOn) return { server }; // daemon still needed by another group
  }
  // Authoritative stop: kill EVERY copy of the daemon — including one started outside the
  // dashboard / orphaned. Safe here: these daemons are plain localhost HTTP servers (no GPU).
  const stopped = await forceStopService(b.service);
  return stopped.ok ? { server } : { server, warning: `${b.name} is off, but stopping its daemon failed: ${stopped.error}` };
}
