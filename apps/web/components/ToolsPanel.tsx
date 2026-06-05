"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Tool toggles (client) — flip individual assistant tools on/off. Disabled tools are
 * filtered out of `streamText` on the next turn (old threads still validate against
 * the full registry — see tool-config.ts).
 */

export interface ToolRow {
  name: string;
  description: string;
  enabled: boolean;
}

export function ToolsPanel({ tools }: { tools: ToolRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (name: string) => {
    const disabled = tools.filter((t) => (t.name === name ? t.enabled : !t.enabled)).map((t) => t.name);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leash/tools", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled }) });
      if (!res.ok) setError(`Save failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Save failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

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
            </div>
          </li>
        ))}
      </ul>
      <p className="kicker mt-4" style={{ color: "var(--color-faint)" }}>
        Disabled tools disappear from the assistant on its next turn. Existing conversations keep rendering their old tool calls.
      </p>
    </div>
  );
}
