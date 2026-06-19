"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, Trash2Icon, ChevronRightIcon, ChevronDownIcon, AlertTriangleIcon, TerminalIcon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { Switch } from "./Switch.tsx";
import { IconButton } from "./IconButton.tsx";

/**
 * Plugins manager (client) — install / enable / review / uninstall plugin bundles
 * (each a `.claude-plugin/plugin.json` manifest that registers namespaced skills,
 * MCP servers, and agents). A freshly installed plugin lands DISABLED (quarantine):
 * the review expander lists every component it WILL register — flagging side-effects
 * (stdio MCP servers, risky/approval-gated tools, skills that ship scripts) — so it's
 * read before the Switch is flipped on. Mirrors SkillsPanel's data-fetching idiom:
 * the installed list arrives as a prop from the server page; mutations call the API
 * and `router.refresh()`.
 */

type SourceKind = "folder" | "upload" | "github" | "mesh" | "marketplace";

interface PluginComponents {
  skills: string[];
  mcpServers: string[];
  agents: string[];
}

interface PluginEntry {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: { kind: SourceKind; ref?: string };
  enabled: boolean;
  components: PluginComponents;
  installedAt: number;
}

interface InventorySkill {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  tools: string[];
  hasScripts: boolean;
  riskyTools: string[];
}
interface InventoryMcp {
  id: string;
  name: string;
  transport: string;
  enabled: boolean;
  stdio: boolean;
  command?: string;
  url?: string;
}
interface InventoryAgent {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  model?: string;
  tools: string[];
  riskyTools: string[];
}
interface Inventory {
  skills: InventorySkill[];
  mcpServers: InventoryMcp[];
  agents: InventoryAgent[];
}

interface MarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  source: { kind: SourceKind; ref?: string };
}
interface CachedMarketplace {
  id: string;
  url: string;
  fetchedAt: number;
  marketplace: { name: string; description?: string; entries: MarketplaceEntry[] };
}

const SOURCE_TABS: SourceKind[] = ["upload", "github", "folder", "mesh", "marketplace"];
const SOURCE_LABEL: Record<SourceKind, string> = { upload: ".zip", github: "GitHub URL", folder: "Folder", mesh: "Mesh", marketplace: "Marketplace" };
const componentCount = (c: PluginComponents): number => c.skills.length + c.mcpServers.length + c.agents.length;

/** Lazy-loaded quarantine review — every component the plugin WILL register, side-effects flagged. */
function ReviewExpander({ id }: { id: string }) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/plugins/${encodeURIComponent(id)}`);
      const body = (await res.json().catch(() => ({}))) as { inventory?: Inventory; error?: string };
      if (!res.ok || !body.inventory) setError(body.error ?? `Couldn't load components (${res.status}).`);
      else setInv(body.inventory);
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setLoading(false);
    }
  };

  // load once on mount
  if (loading && inv === null && error === null) void load();

  if (loading) return <p className="kicker" style={{ color: "var(--color-faint)" }}>Loading components…</p>;
  if (error) return <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">{error}</p>;
  if (!inv) return null;

  const empty = inv.skills.length === 0 && inv.mcpServers.length === 0 && inv.agents.length === 0;
  const flag = (
    <span className="kicker inline-flex items-center gap-1" style={{ color: "var(--color-brick)" }}>
      <AlertTriangleIcon size={11} /> side-effect
    </span>
  );

  return (
    <div className="mt-3 flex flex-col gap-3 border-l-2 pl-3" style={{ borderColor: "var(--color-rule-strong)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        Review — everything this plugin registers when enabled. Side-effect rows run code or carry an approval gate.
      </span>
      {empty && <p className="kicker" style={{ color: "var(--color-faint)" }}>This plugin registers no components.</p>}

      {inv.skills.length > 0 && (
        <div>
          <span className="kicker kicker-sage">Skills · {inv.skills.length}</span>
          <ul className="mt-1">
            {inv.skills.map((s) => (
              <li key={s.slug} className="flex flex-wrap items-center gap-2 py-1" style={{ fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>
                <span>{s.name}</span>
                <span className="kicker" style={{ color: "var(--color-faint)" }}>{s.slug}</span>
                {s.hasScripts && (
                  <span className="kicker inline-flex items-center gap-1" title="Ships scripts/ — runnable via run_skill_script" style={{ color: "var(--color-brick)" }}>
                    <TerminalIcon size={11} /> scripts
                  </span>
                )}
                {s.riskyTools.length > 0 && <span title={`Approval-gated tools: ${s.riskyTools.join(", ")}`}>{flag}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inv.mcpServers.length > 0 && (
        <div>
          <span className="kicker kicker-sage">MCP servers · {inv.mcpServers.length}</span>
          <ul className="mt-1">
            {inv.mcpServers.map((m) => (
              <li key={m.id} className="flex flex-col gap-0.5 py-1" style={{ fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>
                <span className="flex flex-wrap items-center gap-2">
                  <span>{m.name}</span>
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>{m.transport}</span>
                  {m.stdio && (
                    <span className="kicker inline-flex items-center gap-1" title="Local stdio server — launches a process on your machine" style={{ color: "var(--color-brick)" }}>
                      <TerminalIcon size={11} /> spawns process {flag}
                    </span>
                  )}
                </span>
                {(m.command ?? m.url) && (
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--color-muted)" }}>{m.command ?? m.url}</code>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inv.agents.length > 0 && (
        <div>
          <span className="kicker kicker-sage">Agents · {inv.agents.length}</span>
          <ul className="mt-1">
            {inv.agents.map((a) => (
              <li key={a.slug} className="flex flex-wrap items-center gap-2 py-1" style={{ fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>
                <span>{a.name}</span>
                <span className="kicker" style={{ color: "var(--color-faint)" }}>{a.slug}</span>
                {a.model && <span className="kicker" style={{ color: "var(--color-faint)" }}>{a.model}</span>}
                {a.riskyTools.length > 0 && <span title={`Approval-gated tools: ${a.riskyTools.join(", ")}`}>{flag}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PluginsPanel({ plugins }: { plugins: PluginEntry[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Install dialog
  const [installMode, setInstallMode] = useState<SourceKind | null>(null);
  const [installInput, setInstallInput] = useState("");
  const [marketplaces, setMarketplaces] = useState<CachedMarketplace[] | null>(null);
  const [marketUrl, setMarketUrl] = useState("");

  const call = async (fn: () => Promise<Response>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Request failed — is the app still running?");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: PluginEntry) =>
    void call(() => fetchWithTimeout(`/api/leash/plugins/${encodeURIComponent(p.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !p.enabled }) }));

  const del = async (p: PluginEntry) => {
    if (!(await appConfirm(`Uninstall the plugin "${p.name}"? Its skills, MCP servers, and agents are removed.`, { confirmLabel: "Uninstall", destructive: true }))) return;
    void call(() => fetchWithTimeout(`/api/leash/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" }));
  };

  const loadMarketplaces = async () => {
    try {
      const res = await fetchWithTimeout("/api/leash/plugins/marketplaces");
      const body = (await res.json().catch(() => ({}))) as { marketplaces?: CachedMarketplace[]; error?: string };
      if (!res.ok) setError(body.error ?? `Couldn't load marketplaces (${res.status}).`);
      else setMarketplaces(body.marketplaces ?? []);
    } catch {
      setError("Request failed — is the app still running?");
    }
  };

  const openMode = (mode: SourceKind) => {
    setInstallMode(mode);
    setInstallInput("");
    if (mode === "marketplace") void loadMarketplaces();
  };

  const installUpload = (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    void call(() => fetchWithTimeout("/api/leash/plugins/install/upload", { method: "POST", body: fd }, TIMEOUT.heavy)).then((ok) => { if (ok) setInstallMode(null); });
  };

  const installFromInput = () => {
    const input = installInput.trim();
    if (!input) return;
    const url = installMode === "github" ? "/api/leash/plugins/install/github" : installMode === "folder" ? "/api/leash/plugins/install/folder" : "/api/leash/plugins/install/mesh";
    const body = installMode === "github" ? { url: input } : installMode === "folder" ? { path: input } : { pluginId: input };
    void call(() => fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, TIMEOUT.heavy)).then((ok) => { if (ok) setInstallMode(null); });
  };

  const addMarketplace = async () => {
    const url = marketUrl.trim();
    if (!url) return;
    const ok = await call(() => fetchWithTimeout("/api/leash/plugins/marketplaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }, TIMEOUT.heavy));
    if (ok) {
      setMarketUrl("");
      await loadMarketplaces();
    }
  };

  const installFromMarketplace = (marketplaceId: string, name: string) =>
    void call(() => fetchWithTimeout("/api/leash/plugins/install/marketplace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketplaceId, name }) }, TIMEOUT.heavy)).then((ok) => { if (ok) setInstallMode(null); });

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="kicker whitespace-pre-wrap" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {/* Primary action row */}
        <div className="flex items-center gap-3">
          <span className="kicker kicker-sage">Plugins</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          {installMode === null && (
            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              installs land disabled
            </span>
          )}
          <IconButton title="Install plugin (.zip / GitHub / folder / mesh / marketplace)" color="var(--color-sage-deep)" disabled={busy} onClick={() => (installMode === null ? openMode("upload") : setInstallMode(null))}>
            <PlusIcon size={16} />
          </IconButton>
        </div>

        {/* Expanded install row */}
        {installMode !== null && (
          <div className="flex flex-col gap-2 border-l-2 pl-3" style={{ borderColor: "var(--color-rule-strong)" }}>
            {/* Mode tabs */}
            <div className="flex flex-wrap items-center gap-2">
              {SOURCE_TABS.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => openMode(mode)}
                  className="kicker border px-2.5 py-1 transition-opacity hover:opacity-80"
                  style={{
                    borderColor: installMode === mode ? "var(--color-sage-deep)" : "var(--color-rule-strong)",
                    color: installMode === mode ? "var(--color-sage-deep)" : "var(--color-muted)",
                  }}
                >
                  {SOURCE_LABEL[mode]}
                </button>
              ))}
            </div>

            {/* upload */}
            {installMode === "upload" && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="kicker cursor-pointer border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                  Browse…
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = ""; // allow re-selecting the same file
                      if (f) installUpload(f);
                    }}
                  />
                </label>
                <span className="kicker" style={{ color: "var(--color-faint)" }}>a .zip of a plugin folder</span>
              </div>
            )}

            {/* github / folder / mesh — single text input + action */}
            {(installMode === "github" || installMode === "folder" || installMode === "mesh") && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={installInput}
                  onChange={(e) => setInstallInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && installInput.trim()) installFromInput(); }}
                  placeholder={installMode === "github" ? "https://github.com/owner/repo" : installMode === "folder" ? "/path/to/plugin-dir" : "plugin id advertised on the mesh"}
                  aria-label={installMode === "github" ? "GitHub repository URL" : installMode === "folder" ? "Local folder path" : "Mesh plugin id"}
                  className="flex-1 border bg-transparent px-3 py-1.5"
                  style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", minWidth: "14rem" }}
                  disabled={busy}
                />
                <button
                  type="button"
                  disabled={busy || !installInput.trim()}
                  onClick={installFromInput}
                  className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
                  style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
                >
                  Install
                </button>
              </div>
            )}

            {/* marketplace — add a marketplace URL + browse cached entries */}
            {installMode === "marketplace" && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={marketUrl}
                    onChange={(e) => setMarketUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && marketUrl.trim()) void addMarketplace(); }}
                    placeholder="https://…/marketplace.json — add / refresh a marketplace"
                    aria-label="Marketplace URL"
                    className="flex-1 border bg-transparent px-3 py-1.5"
                    style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", minWidth: "14rem" }}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    disabled={busy || !marketUrl.trim()}
                    onClick={() => void addMarketplace()}
                    className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
                    style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
                  >
                    Add marketplace
                  </button>
                </div>
                {marketplaces === null ? (
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>Loading marketplaces…</span>
                ) : marketplaces.length === 0 ? (
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>No marketplaces cached yet — add one above.</span>
                ) : (
                  marketplaces.map((m) => (
                    <div key={m.id} className="flex flex-col gap-1">
                      <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>
                        {m.marketplace.name} <span style={{ color: "var(--color-faint)" }}>· {m.marketplace.entries.length} plugins</span>
                      </span>
                      <ul>
                        {m.marketplace.entries.map((e) => (
                          <li key={`${m.id}:${e.name}`} className="flex flex-wrap items-center gap-2 py-1" style={{ fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>
                            <span className="min-w-0 flex-1">
                              {e.name}
                              {e.version && <span className="kicker ml-1" style={{ color: "var(--color-faint)" }}>{e.version}</span>}
                              {e.description && <span className="ml-2" style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>{e.description}</span>}
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => installFromMarketplace(m.id, e.name)}
                              className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
                              style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
                            >
                              Install
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            )}

            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              installs land disabled — review the components, then enable
            </span>
          </div>
        )}
      </div>

      {plugins.length === 0 ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No plugins yet — install one and its skills, MCP servers, and agents land here for review before you enable them.
        </p>
      ) : (
        <ul>
          {plugins.map((p) => {
            const open = expanded === p.id;
            return (
              <li key={p.id} className="flex flex-col border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: p.enabled ? 1 : 0.6 }}>
                <div className="flex flex-wrap items-center gap-3">
                  <Switch on={p.enabled} disabled={busy} onChange={() => toggle(p)} label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`} />
                  <div className="min-w-0 flex-1">
                    <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>
                      {p.name}
                      {p.version && <span className="kicker ml-1" style={{ color: "var(--color-faint)" }}>{p.version}</span>}
                      <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>{p.source.kind}</span>
                      <span className="kicker ml-2" style={{ color: "var(--color-sage-deep)" }}>
                        {componentCount(p.components)} component{componentCount(p.components) === 1 ? "" : "s"}
                      </span>
                    </p>
                    <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{p.description || "(no description)"}</p>
                    {!p.enabled && (
                      <p className="kicker inline-flex items-center gap-1" style={{ color: "var(--color-brick)" }}>
                        <AlertTriangleIcon size={11} /> Disabled — review then enable
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : p.id)}
                    className="kicker inline-flex items-center gap-1 transition-opacity hover:opacity-70"
                    style={{ color: "var(--color-muted)" }}
                    aria-expanded={open}
                  >
                    {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />} Review
                  </button>
                  <IconButton title={`Uninstall ${p.name}`} danger disabled={busy} onClick={() => void del(p)}>
                    <Trash2Icon size={15} />
                  </IconButton>
                </div>
                {open && <ReviewExpander id={p.id} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
