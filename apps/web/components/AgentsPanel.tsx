"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { Switch } from "./Switch.tsx";
import { IconButton } from "./IconButton.tsx";
import { VisibilityFilter, type Visibility } from "./VisibilityFilter.tsx";
import { toast } from "./Toast.tsx";

/**
 * Subagents editor (client) — create / edit / enable / delete specialized assistants the
 * model can delegate to (one callable tool per enabled agent). Two sources arrive together
 * from the list API: USER agents (created/edited here, fully editable) and PLUGIN agents
 * (provided by an installed plugin — READ-ONLY here; enable/disable happens via the plugin).
 * Mirrors SkillsPanel's create/edit/enable/delete idiom and PluginsPanel's "provided by a
 * plugin" read-only badge: the list arrives as a prop from the server page; mutations call
 * the API and `router.refresh()`. Local interface matches the JSON (no server-only import).
 */

/** Client-side shape of one subagent — mirrors the `Agent` JSON from /api/leash/agents. */
interface Agent {
  slug: string;
  source: "user" | "plugin";
  pluginId: string;
  name: string;
  description: string;
  body: string;
  model: string;
  tools: string[];
  disallowedTools: string[];
  skills: string[];
  maxTurns: number;
  enabled: boolean;
  builtin: boolean;
  mcpServers: { refs: string[]; inline: unknown[] };
  memory: string;
  permissionMode: string;
  hooks: string;
  background: boolean;
  effort: string;
  isolation: string;
  color: string;
  initialPrompt: string;
}

interface Draft {
  name: string;
  description: string;
  body: string;
  model: string;
  tools: string;
  disallowedTools: string;
  skills: string;
  maxTurns: string;
}

const EMPTY: Draft = { name: "", description: "", body: "", model: "", tools: "", disallowedTools: "", skills: "", maxTurns: "" };

/** Comma-separated text input ⇄ string[] (the API wants arrays). */
const splitList = (s: string): string[] => s.split(",").map((t) => t.trim()).filter(Boolean);
const joinList = (a: string[]): string => a.join(", ");

const draftFrom = (a: Agent): Draft => ({
  name: a.name,
  description: a.description,
  body: a.body,
  model: a.model,
  tools: joinList(a.tools),
  disallowedTools: joinList(a.disallowedTools),
  skills: joinList(a.skills),
  maxTurns: a.maxTurns ? String(a.maxTurns) : "",
});

export function AgentsPanel({ agents, mainAgent }: { agents: Agent[]; mainAgent: { name: string } }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Visibility>("all");

  const isBuiltin = (a: Agent) => a.builtin || a.source === "plugin";
  const counts: Record<Visibility, number> = {
    all: agents.length,
    builtin: agents.filter(isBuiltin).length,
    custom: agents.filter((a) => !isBuiltin(a)).length,
  };
  const visible = agents.filter((a) => (filter === "all" ? true : filter === "builtin" ? isBuiltin(a) : !isBuiltin(a)));

  const call = async (fn: () => Promise<Response>, success?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Request failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return false;
      }
      if (success) toast.success(success);
      router.refresh();
      return true;
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (a: Agent) => {
    setEditing(a.slug);
    setDraft(draftFrom(a));
  };

  const payload = () => {
    const maxTurns = Number.parseInt(draft.maxTurns, 10);
    return {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      model: draft.model.trim(),
      tools: splitList(draft.tools),
      disallowedTools: splitList(draft.disallowedTools),
      skills: splitList(draft.skills),
      ...(Number.isFinite(maxTurns) && maxTurns >= 1 ? { maxTurns } : {}),
    };
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    const ok =
      editing === "new"
        ? await call(() => fetchWithTimeout("/api/leash/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) }), "Subagent created")
        : await call(() => fetchWithTimeout(`/api/leash/agents/${editing}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) }), "Subagent saved");
    if (ok) {
      setEditing(null);
      setDraft(EMPTY);
    }
  };

  const toggle = (a: Agent) =>
    void call(() => fetchWithTimeout(`/api/leash/agents/${a.slug}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !a.enabled }) }), `Subagent ${a.enabled ? "disabled" : "enabled"}`);

  const del = async (a: Agent) => {
    if (!(await appConfirm(`Delete the subagent "${a.name}"?`, { confirmLabel: "Delete", destructive: true }))) return;
    void call(() => fetchWithTimeout(`/api/leash/agents/${a.slug}`, { method: "DELETE" }), "Subagent deleted");
  };

  const editor = (
    <section className="border p-4" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}>
      <span className="kicker kicker-sage">{editing === "new" ? "New subagent" : `Editing · ${editing}`}</span>
      <div className="mt-3 flex flex-col gap-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Subagent name (e.g. Interaction checker)"
          aria-label="Subagent name"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-body)" }}
        />
        <input
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="When should the assistant delegate to this? (it shows in the tool description)"
          aria-label="Subagent description"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.9rem" }}
        />
        <textarea
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          placeholder={"System prompt — the instructions the subagent follows when invoked…"}
          rows={10}
          aria-label="Subagent system prompt"
          className="border bg-transparent p-3"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", lineHeight: 1.5 }}
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            placeholder="model alias (optional — default chat model)"
            aria-label="Model alias"
            className="flex-1 border bg-transparent px-3 py-2"
            style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", minWidth: "12rem" }}
          />
          <input
            value={draft.maxTurns}
            onChange={(e) => setDraft((d) => ({ ...d, maxTurns: e.target.value.replace(/[^0-9]/g, "") }))}
            placeholder="max turns"
            inputMode="numeric"
            aria-label="Max turns"
            className="border bg-transparent px-3 py-2"
            style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", width: "8rem" }}
          />
        </div>
        <input
          value={draft.tools}
          onChange={(e) => setDraft((d) => ({ ...d, tools: e.target.value }))}
          placeholder="tools — comma list the subagent may use (empty ⇒ a sane default)"
          aria-label="Allowed tools"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}
        />
        <input
          value={draft.disallowedTools}
          onChange={(e) => setDraft((d) => ({ ...d, disallowedTools: e.target.value }))}
          placeholder="disallowed tools — comma list removed from the allow-set"
          aria-label="Disallowed tools"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}
        />
        <input
          value={draft.skills}
          onChange={(e) => setDraft((d) => ({ ...d, skills: e.target.value }))}
          placeholder="skills to preload — comma list of skill slugs loaded into the subagent's context"
          aria-label="Skills to preload"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
          Save subagent
        </button>
        <button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(EMPTY); }} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
          Cancel
        </button>
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {editing !== null ? (
        editor
      ) : (
        <div className="flex items-center gap-3">
          <span className="kicker kicker-sage">Subagents</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            one tool per enabled agent
          </span>
          <VisibilityFilter value={filter} onChange={setFilter} builtinLabel="Built-in" customLabel="Custom" counts={counts} />
          <IconButton title="New subagent" color="var(--color-sage-deep)" onClick={() => { setEditing("new"); setDraft(EMPTY); }}>
            <PlusIcon size={16} />
          </IconButton>
        </div>
      )}

      <div className="border p-3" style={{ borderColor: "var(--color-rule-strong)" }}>
        <p className="kicker" style={{ color: "var(--color-muted)" }}>Main orchestrator</p>
        <p style={{ fontFamily: "var(--font-body)" }}>{mainAgent.name}</p>
        <p className="kicker" style={{ color: "var(--color-faint)" }}>Always on — routes to the specialists below when a request is outside its strength.</p>
      </div>

      {agents.length === 0 && editing === null ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No subagents yet — write one and the assistant can delegate matching work to it as a callable tool.
        </p>
      ) : visible.length === 0 && editing === null ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No {filter === "builtin" ? "built-in" : "custom"} subagents.
        </p>
      ) : (
        <ul>
          {visible.map((a) => {
            const isPlugin = a.source === "plugin";
            const summary = [
              a.tools.length > 0 ? `${a.tools.length} tool${a.tools.length > 1 ? "s" : ""}` : null,
              a.skills.length > 0 ? `${a.skills.length} skill${a.skills.length > 1 ? "s" : ""}` : null,
            ].filter(Boolean);
            return (
              <li key={a.slug} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: a.enabled ? 1 : 0.6 }}>
                <Switch
                  on={a.enabled}
                  disabled={busy || isPlugin}
                  onChange={() => { if (!isPlugin) toggle(a); }}
                  label={isPlugin ? `${a.name} — enable via its plugin` : `${a.enabled ? "Disable" : "Enable"} ${a.name}`}
                />
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>
                    {a.name} <span className="kicker ml-1" style={{ color: "var(--color-faint)" }}>{a.slug}</span>
                    {isPlugin && (
                      <span className="kicker ml-2" style={{ color: "var(--color-sage-deep)" }}>
                        plugin: {a.pluginId}
                      </span>
                    )}
                    {a.model && <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>{a.model}</span>}
                    {summary.length > 0 && <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>{summary.join(" · ")}</span>}
                  </p>
                  <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{a.description || "(no description — the assistant won't know when to delegate to it)"}</p>
                  {(a.memory || a.mcpServers.refs.length || a.mcpServers.inline.length) && (
                    <p className="kicker" style={{ color: "var(--color-muted)" }}>
                      {[a.memory ? `memory: ${a.memory}` : "", (a.mcpServers.refs.length || a.mcpServers.inline.length) ? `mcp: ${a.mcpServers.refs.length} ref + ${a.mcpServers.inline.length} inline` : ""].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {[a.permissionMode && `permissionMode=${a.permissionMode}`, a.effort && `effort=${a.effort}`, a.color && `color=${a.color}`, a.background && "background", a.isolation && `isolation=${a.isolation}`, a.initialPrompt && "initialPrompt", a.hooks && "hooks"].filter(Boolean).length > 0 && (
                    <p className="kicker" style={{ color: "var(--color-faint)" }}>
                      {"reserved (parsed, not yet wired): "}
                      {[a.permissionMode && `permissionMode=${a.permissionMode}`, a.effort && `effort=${a.effort}`, a.color && `color=${a.color}`, a.background && "background", a.isolation && `isolation=${a.isolation}`, a.initialPrompt && "initialPrompt", a.hooks && "hooks"].filter(Boolean).join(", ")}
                      {isPlugin ? " — mcpServers/permissionMode/hooks ignored for plugin agents" : ""}
                    </p>
                  )}
                  {isPlugin && (
                    <p className="kicker" style={{ color: "var(--color-faint)" }}>read-only — enable via its plugin</p>
                  )}
                </div>
                {!isPlugin && (
                  <>
                    <IconButton title={`Edit ${a.name}`} disabled={busy} onClick={() => startEdit(a)}>
                      <PencilIcon size={15} />
                    </IconButton>
                    <IconButton title={`Delete ${a.name}`} danger disabled={busy} onClick={() => void del(a)}>
                      <Trash2Icon size={15} />
                    </IconButton>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
