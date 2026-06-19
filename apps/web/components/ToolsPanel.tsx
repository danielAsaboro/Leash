"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlertIcon, PuzzleIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { Switch } from "./Switch.tsx";
import { IconButton } from "./IconButton.tsx";
import { VisibilityFilter, type Visibility } from "./VisibilityFilter.tsx";
import { toast } from "./Toast.tsx";

/**
 * Tool toggles (client) — flip individual assistant tools on/off, and mark tools
 * "Ask first" (the model's call pauses on an in-chat approval card until the user
 * approves or denies). Disabled tools are filtered out of `streamText` on the next
 * turn (old threads still validate against the full registry — see tool-config.ts).
 */

export interface ToolRow {
  name: string;
  description: string;
  enabled: boolean;
  /** Effective ask-first state (override ?? default). */
  askFirst: boolean;
  /** Whether this tool is ask-first by default (shown as a hint). */
  askFirstDefault: boolean;
  /** Optional status line under the description (e.g. which model drives a computer-use tool). */
  infoNote?: string;
  /** True for tools sourced from an MCP server (gets an icon slot — real icon or placeholder). */
  mcp?: boolean;
  /** MCP-advertised tool icon, resolved to a cached data URI (offline-safe). */
  iconDataUri?: string;
}

export function ToolsPanel({ tools }: { tools: ToolRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Visibility>("all");

  // "Built-in" = native Leash tools; "custom" = tools sourced from a connected MCP server (`mcp`).
  const counts: Record<Visibility, number> = {
    all: tools.length,
    builtin: tools.filter((t) => !t.mcp).length,
    custom: tools.filter((t) => t.mcp).length,
  };
  const visible = tools.filter((t) => (filter === "all" ? true : filter === "builtin" ? !t.mcp : !!t.mcp));

  const put = async (body: { disabled?: string[]; askFirst?: Record<string, boolean> }, success: string) => {
    setBusy(true);
    setError(null);
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
      setBusy(false);
    }
  };

  const toggle = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    return put({ disabled: tools.filter((t) => (t.name === name ? t.enabled : !t.enabled)).map((t) => t.name) }, `${name} ${tool?.enabled ? "disabled" : "enabled"}`);
  };
  const toggleAsk = (t: ToolRow) => put({ askFirst: { [t.name]: !t.askFirst } }, `Ask first ${t.askFirst ? "disabled" : "enabled"} for ${t.name}`);

  return (
    <div>
      {error && (
        <p className="kicker mb-3" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      <div className="mb-3 flex items-center gap-3">
        <span className="kicker kicker-sage">Tools</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <VisibilityFilter value={filter} onChange={setFilter} customLabel="MCP" counts={counts} />
      </div>
      <ul>
        {visible.map((t) => (
          <li key={t.name} className="flex items-start gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: t.enabled ? 1 : 0.6 }}>
            <div className="mt-0.5">
              <Switch on={t.enabled} disabled={busy} onChange={() => void toggle(t.name)} label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2" style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                {/* MCP tools get an icon slot: the server-advertised icon (spec SEP-973, cached as a
                    data URI, <img>-only so an SVG can't run script) or a placeholder. Built-ins: none. */}
                {(t.iconDataUri || t.mcp) && (
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
                )}
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
      <p className="kicker mt-4" style={{ color: "var(--color-faint)" }}>
        Disabled tools disappear from the assistant on its next turn. Existing conversations keep rendering their old tool calls. “Ask first” pauses that
        tool's calls on an in-chat approval card — approve to run, deny to skip; the toggle applies from the next turn.
      </p>
    </div>
  );
}
