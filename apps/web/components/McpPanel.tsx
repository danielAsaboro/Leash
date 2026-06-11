"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, Trash2Icon, GlobeIcon, RadioIcon, TerminalIcon, LockIcon, ShieldCheckIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import { Switch } from "./Switch.tsx";
import { McpIntegrationModal } from "./McpIntegrationModal.tsx";
import type { McpServerStatus } from "../lib/leash/mcp.ts";
import type { McpTransport } from "../lib/leash/mcp-config.ts";

/**
 * Brain → MCP — the assistant's tool integrations. The "Mesh Tools" built-in is pinned
 * and non-deletable (toggling it starts/stops the leash-mcp daemon AND connects); env
 * rows (LEASH_MCP_SERVERS) are read-only; custom rows can be toggled or removed. Tools
 * from connected servers appear in Brain → Tools and in chat. Add via the modal.
 */

const TRANSPORT_ICON: Record<McpTransport, typeof GlobeIcon> = { http: GlobeIcon, sse: RadioIcon, stdio: TerminalIcon };

function target(s: McpServerStatus): string {
  return s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") : s.url ?? "";
}

export function McpPanel({ servers }: { servers: McpServerStatus[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const toggle = async (s: McpServerStatus) => {
    setBusyId(s.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/mcp/${encodeURIComponent(s.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) setError(body.error ?? `Request failed (${res.status}).`);
      else if (body.warning) setNotice(body.warning);
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: McpServerStatus) => {
    if (!confirm(`Remove the MCP server "${s.name}"?`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/mcp/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
      }
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {adding && <McpIntegrationModal existing={servers} onClose={() => setAdding(false)} />}

      <div className="flex items-center gap-3">
        <span className="kicker kicker-sage">Integrations</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <IconButton title="Add integration" color="var(--color-sage-deep)" onClick={() => setAdding(true)}>
          <PlusIcon size={16} />
        </IconButton>
      </div>

      {error && (
        <p className="kicker whitespace-pre-wrap" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="kicker" style={{ color: "var(--color-clay, var(--color-muted))" }}>
          {notice}
        </p>
      )}

      <ul>
        {servers.map((s) => {
          const TIcon = TRANSPORT_ICON[s.transport];
          const readOnly = !!s.fromEnv;
          const secretCount = (s.headerNames?.length ?? 0) + (s.envNames?.length ?? 0);
          const starting = busyId === s.id;
          // Built-ins ARE a daemon we start/stop → start/stop language; remote rows are a connection.
          const statusText = s.builtin
            ? s.connected
              ? "● running"
              : starting
                ? "○ starting…"
                : s.enabled
                  ? "○ not responding"
                  : "○ stopped"
            : s.connected
              ? "● connected"
              : starting
                ? "○ connecting…"
                : s.enabled
                  ? "○ not connected"
                  : "○ off";
          return (
            <li key={s.id} className="flex flex-wrap items-start gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: s.enabled ? 1 : 0.6 }}>
              <div className="mt-0.5">
                <Switch
                  on={s.enabled}
                  busy={starting}
                  disabled={busyId !== null || readOnly}
                  onChange={() => void toggle(s)}
                  label={readOnly ? "From LEASH_MCP_SERVERS — read-only" : s.builtin ? `${s.enabled ? "Stop" : "Start"} ${s.name}` : `${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2" style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>
                  {s.name}
                  <span title={s.transport} className="inline-flex items-center" style={{ color: "var(--color-faint)" }}>
                    <TIcon size={13} />
                  </span>
                  <span className="kicker" style={{ color: s.connected ? "var(--color-sage-deep)" : "var(--color-faint)" }}>
                    {statusText}
                  </span>
                  {s.builtin && (
                    <span className="kicker inline-flex items-center gap-1" style={{ color: "var(--color-faint)" }}>
                      <ShieldCheckIcon size={12} /> built-in
                    </span>
                  )}
                  {s.fromEnv && (
                    <span className="kicker" style={{ color: "var(--color-faint)" }}>
                      env
                    </span>
                  )}
                  {secretCount > 0 && (
                    <span className="kicker inline-flex items-center gap-1" title={[...(s.headerNames ?? []), ...(s.envNames ?? [])].join(", ")} style={{ color: "var(--color-faint)" }}>
                      <LockIcon size={11} /> {secretCount}
                    </span>
                  )}
                </p>
                {s.builtin && <p style={{ color: "var(--color-faint)", fontSize: "0.82rem", fontFamily: "var(--font-body)" }}>Pair & manage mesh devices from chat — toggling this starts the mesh-tools daemon.</p>}
                <p style={{ color: "var(--color-muted)", fontSize: "0.82rem", fontFamily: "var(--font-mono)" }}>{target(s)}</p>
                {s.connected && s.toolNames.length > 0 && (
                  <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>tools: {s.toolNames.join(", ")}</p>
                )}
                {s.error && (
                  <p className="kicker" style={{ color: "var(--color-brick)" }}>
                    {s.error}
                  </p>
                )}
              </div>
              {!readOnly && !s.builtin && (
                <IconButton title={`Remove ${s.name}`} danger disabled={busyId !== null} onClick={() => void remove(s)}>
                  <Trash2Icon size={15} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>

      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Tools from connected servers appear in Brain → Tools and in chat. Built-in & env servers can be turned off but not removed.
      </p>
    </div>
  );
}
