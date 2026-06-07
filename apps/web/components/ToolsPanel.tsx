"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";

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
}

export function ToolsPanel({ tools }: { tools: ToolRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const put = async (body: { disabled?: string[]; askFirst?: Record<string, boolean> }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/tools", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) setError(`Save failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Save failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) => put({ disabled: tools.filter((t) => (t.name === name ? t.enabled : !t.enabled)).map((t) => t.name) });
  const toggleAsk = (t: ToolRow) => put({ askFirst: { [t.name]: !t.askFirst } });

  return (
    <div>
      {error && (
        <p className="kicker mb-3" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      <ul>
        {tools.map((t) => (
          <li key={t.name} className="flex items-start gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: t.enabled ? 1 : 0.55 }}>
            <input type="checkbox" className="mt-1" checked={t.enabled} onChange={() => void toggle(t.name)} disabled={busy} aria-label={`Enable ${t.name}`} />
            <div className="min-w-0 flex-1">
              <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>{t.name}</p>
              <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{t.description}</p>
              {t.infoNote && (
                <p className="kicker mt-1" style={{ color: "var(--color-faint)" }}>
                  {t.infoNote}
                </p>
              )}
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 pt-0.5" title={t.askFirstDefault ? "Ask first by default for this tool" : undefined}>
              <input type="checkbox" checked={t.askFirst} onChange={() => void toggleAsk(t)} disabled={busy || !t.enabled} aria-label={`Ask first before running ${t.name}`} />
              <span className="kicker" style={{ color: t.askFirst ? "var(--color-ink-soft)" : "var(--color-faint)" }}>
                Ask first
              </span>
            </label>
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
