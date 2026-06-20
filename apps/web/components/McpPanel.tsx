"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, Trash2Icon, GlobeIcon, RadioIcon, TerminalIcon, LockIcon, ShieldCheckIcon, BlocksIcon, PencilIcon, ChevronDownIcon, ChevronRightIcon, PuzzleIcon, ShieldAlertIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { IconButton } from "./IconButton.tsx";
import { Switch } from "./Switch.tsx";
import { McpIntegrationModal } from "./McpIntegrationModal.tsx";
import { VisibilityFilter, type Visibility } from "./VisibilityFilter.tsx";
import { toast } from "./Toast.tsx";
import type { McpServerStatus } from "../lib/leash/mcp.ts";
import type { McpTransport } from "../lib/leash/mcp-config.ts";

/**
 * Brain → MCP — the assistant's tool integrations. The "Mesh Tools" built-in is pinned
 * and non-deletable (toggling it starts/stops the leash-mcp daemon AND connects); env
 * rows (LEASH_MCP_SERVERS) are read-only; custom rows can be toggled or removed. Each
 * row expands into the live tool inventory for that server, with the existing per-tool
 * enable + ask-first controls. Add servers via the modal.
 */

const TRANSPORT_ICON: Record<McpTransport, typeof GlobeIcon> = { http: GlobeIcon, sse: RadioIcon, stdio: TerminalIcon };

export interface McpToolRow {
  name: string;
  description: string;
  enabled: boolean;
  askFirst: boolean;
  askFirstDefault: boolean;
  infoNote?: string;
  iconDataUri?: string;
}

type McpPanelServer = Omit<McpServerStatus, "tools"> & { tools?: McpToolRow[] };

function target(s: McpServerStatus): string {
  if (s.transport !== "stdio") return s.url ?? "";
  const command = [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
  return s.cwd ? `${command} · cwd ${s.cwd}` : command;
}

export function McpPanel({ servers }: { servers: McpPanelServer[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpServerStatus | null>(null);
  const [filter, setFilter] = useState<Visibility>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // "Built-in" = the pinned Mesh Tools daemon; "custom" = every other row (added here or via env).
  const counts: Record<Visibility, number> = {
    all: servers.length,
    builtin: servers.filter((s) => s.builtin).length,
    custom: servers.filter((s) => !s.builtin).length,
  };
  const visible = servers.filter((s) => (filter === "all" ? true : filter === "builtin" ? s.builtin : !s.builtin));
  const busy = busyId !== null || busyTool !== null;
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const putTools = async (body: { enabled?: Record<string, boolean>; askFirst?: Record<string, boolean> }, success: string, key: string) => {
    setBusyTool(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithTimeout("/api/leash/tools", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const msg = `Save failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return;
      }
      toast.success(success);
      router.refresh();
    } catch {
      const msg = "Save failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusyTool(null);
    }
  };

  const toggleTool = (tool: McpToolRow) =>
    putTools({ enabled: { [tool.name]: !tool.enabled } }, `${tool.name} ${tool.enabled ? "disabled" : "enabled"}`, tool.name);
  const toggleAsk = (tool: McpToolRow) =>
    putTools({ askFirst: { [tool.name]: !tool.askFirst } }, `Ask first ${tool.askFirst ? "disabled" : "enabled"} for ${tool.name}`, tool.name);

  const toggle = async (s: McpServerStatus) => {
    setBusyId(s.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/mcp/${encodeURIComponent(s.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) {
        const msg = body.error ?? `Request failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return;
      }
      if (body.warning) {
        setNotice(body.warning);
        toast.info(body.warning);
      } else {
        toast.success(`${s.name} ${s.enabled ? "disabled" : s.builtin ? "started" : "enabled"}`);
      }
      router.refresh();
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: McpServerStatus) => {
    if (!(await appConfirm(`Remove the MCP server "${s.name}"?`, { confirmLabel: "Remove", destructive: true }))) return;
    setBusyId(s.id);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/mcp/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Request failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return;
      }
      toast.success("MCP server removed");
      router.refresh();
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {(adding || editing) && <McpIntegrationModal existing={servers} editing={editing ?? undefined} onClose={() => { setAdding(false); setEditing(null); }} />}

      <div className="flex items-center gap-3">
        <span className="kicker kicker-sage">Integrations</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <VisibilityFilter value={filter} onChange={setFilter} counts={counts} />
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
        {visible.map((s) => {
          const TIcon = TRANSPORT_ICON[s.transport];
          const readOnly = !!s.fromEnv;
          const secretCount = (s.headerNames?.length ?? 0) + (s.envNames?.length ?? 0);
          const starting = busyId === s.id;
          const open = expanded.has(s.id);
          const toolCount = s.tools?.length ?? 0;
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
                  disabled={busy || readOnly}
                  onChange={() => void toggle(s)}
                  label={readOnly ? "From LEASH_MCP_SERVERS — read-only" : s.builtin ? `${s.enabled ? "Stop" : "Start"} ${s.name}` : `${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2" style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>
                  <span
                    className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded"
                    style={{ background: "var(--color-rule)" }}
                    title={s.iconDataUri ? `${s.name} icon` : undefined}
                  >
                    {/* MCP-advertised brand icon (spec SEP-973), pre-fetched + cached as a data URI;
                        rendered via <img> only, so even an SVG can't run script. Placeholder otherwise. */}
                    {s.iconDataUri ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.iconDataUri} alt="" width={18} height={18} style={{ objectFit: "contain" }} />
                    ) : (
                      <BlocksIcon size={12} style={{ color: "var(--color-faint)" }} />
                    )}
                  </span>
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
                {s.connected && (
                  <p className="kicker" style={{ color: "var(--color-faint)" }}>
                    {toolCount > 0 ? `${toolCount} live tool${toolCount === 1 ? "" : "s"}` : "Connected — tool inventory is live"}
                  </p>
                )}
                {s.error && (
                  <p className="kicker" style={{ color: "var(--color-brick)" }}>
                    {s.error}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => toggleExpanded(s.id)}
                className="kicker inline-flex items-center gap-1 transition-opacity hover:opacity-70"
                style={{ color: "var(--color-muted)" }}
                aria-expanded={open}
              >
                {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                {toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "Tools"}
              </button>
              {!readOnly && (
                <IconButton title={`Edit ${s.name}`} disabled={busy} onClick={() => setEditing(s)}>
                  <PencilIcon size={14} />
                </IconButton>
              )}
              {!readOnly && !s.builtin && (
                <IconButton title={`Remove ${s.name}`} danger disabled={busy} onClick={() => void remove(s)}>
                  <Trash2Icon size={15} />
                </IconButton>
              )}
              {open && (
                <div className="w-full pl-[46px]">
                  {s.tools === undefined ? (
                    <p className="kicker rounded border px-3 py-2" style={{ borderColor: "var(--color-rule)", color: "var(--color-faint)" }}>
                      Live tool inventory is only available while this server is connected.
                    </p>
                  ) : s.tools.length === 0 ? (
                    <p className="kicker rounded border px-3 py-2" style={{ borderColor: "var(--color-rule)", color: "var(--color-faint)" }}>
                      This server is connected but is not advertising any tools.
                    </p>
                  ) : (
                    <ul className="rounded border" style={{ borderColor: "var(--color-rule)" }}>
                      {s.tools.map((t) => (
                        <li key={t.name} className="flex items-start gap-3 border-b px-3 py-3 last:border-b-0" style={{ borderColor: "var(--color-rule)", opacity: t.enabled ? 1 : 0.6 }}>
                          <div className="mt-0.5">
                            <Switch on={t.enabled} disabled={busy} onChange={() => void toggleTool(t)} label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-2" style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                              <span
                                className="inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded"
                                style={{ background: t.iconDataUri ? "var(--color-rule)" : "transparent" }}
                              >
                                {t.iconDataUri ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={t.iconDataUri} alt="" width={16} height={16} style={{ objectFit: "contain" }} />
                                ) : (
                                  <PuzzleIcon size={11} style={{ color: "var(--color-faint)" }} />
                                )}
                              </span>
                              {t.name}
                            </p>
                            <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{t.description}</p>
                            {t.infoNote && (
                              <p className="kicker mt-1" style={{ color: "var(--color-faint)" }}>
                                {t.infoNote}
                              </p>
                            )}
                          </div>
                          <div className="pt-0.5">
                            <IconButton
                              title={t.askFirst ? "Ask first: on — this tool's calls pause for approval" : t.askFirstDefault ? "Ask first: off (on by default for this tool)" : "Ask first: off"}
                              color={t.askFirst ? "var(--color-sage-deep)" : "var(--color-faint)"}
                              disabled={busy || !t.enabled}
                              onClick={() => void toggleAsk(t)}
                            >
                              <ShieldAlertIcon size={15} />
                            </IconButton>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Expand a row to review its live tools and approval gates. Built-in and env-backed servers can be turned off but not removed.
      </p>
    </div>
  );
}
